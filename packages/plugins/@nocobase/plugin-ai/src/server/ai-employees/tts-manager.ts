/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { TTSAudioFormat, TTSProvider, TTSProviderError, TTSRateLimitError } from '@nocobase/ai';
import { Repository } from '@nocobase/database';
import { Sentence, SentenceSplitter } from './sentence-splitter';

export interface TTSSseSink {
  send(event: string, data: unknown): void;
}

export interface TTSStorageWriteResult {
  id: number;
  url: string;
  path?: string;
}

export type TTSStorageWrite = (stream: ReadableStream<Uint8Array>, filename: string) => Promise<TTSStorageWriteResult>;

export interface MessageTTSPipelineOptions {
  provider: TTSProvider;
  model: string;
  voice: string;
  speed: number;
  format: TTSAudioFormat;
  messageId: string;
  sourceMessageRowId?: number;
  sse: TTSSseSink;
  aiFilesRepo: Repository;
  storageWrite: TTSStorageWrite;
  concurrency?: number;
}

export interface TTSSourceHashInput {
  text: string;
  model: string;
  voice: string;
  speed: number;
  format: TTSAudioFormat;
}

/**
 * Deterministic sha256 over the cache key components.
 *
 * We do NOT use JSON.stringify: a stable null-byte-delimited tuple keeps the
 * hash invariant under minor representational changes (e.g. integer 1 vs 1.0).
 */
export function computeTTSSourceHash(input: TTSSourceHashInput): string {
  const payload = [input.text, input.model, input.voice, String(input.speed), input.format].join('\0');
  return createHash('sha256').update(payload).digest('hex');
}

const DEFAULT_CONCURRENCY = 3;

function resolveDefaultConcurrency(): number {
  const raw = process.env.AI_TTS_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(parsed);
}

interface PendingChunk {
  seq: number;
  range: [number, number];
  resolved?: { kind: 'ok'; url: string } | { kind: 'failed' } | { kind: 'dropped' };
}

/**
 * Streaming TTS pipeline for a single assistant message.
 *
 * - `pushToken` is synchronous and never blocks the LLM loop. It runs the
 *   splitter and schedules any newly-yielded sentences without awaiting.
 * - `end()` flushes the splitter and awaits all in-flight TTS work.
 * - `audio-chunk` SSE events are buffered and emitted in seq order even if the
 *   underlying TTS calls finish out of order.
 *
 * Cache strategy: a hit on `aiFiles.sourceHash` reuses the existing storage
 * row's URL directly (no new row is written). The hash already binds the
 * (model, voice, speed, format, text) tuple, so replay can look up the same
 * row by sourceHash without needing a per-message duplicate. Misses produce a
 * single new `aiFiles` row referencing the new storage path.
 */
export class MessageTTSPipeline {
  private readonly splitter = new SentenceSplitter();
  private readonly options: MessageTTSPipelineOptions;
  private readonly concurrency: number;
  private readonly pending: PendingChunk[] = [];
  /** Outstanding work — task wrappers, including the time spent waiting on a permit. */
  private readonly outstanding = new Set<Promise<void>>();
  /** Resolvers waiting for a permit when at capacity. */
  private readonly permitWaiters: Array<() => void> = [];
  private inFlight = 0;
  private nextSeq = 0;
  private nextEmitSeq = 0;
  private canceled = false;

  constructor(options: MessageTTSPipelineOptions) {
    this.options = options;
    this.concurrency = Math.max(1, options.concurrency ?? resolveDefaultConcurrency());
  }

  pushToken(token: string): void {
    if (this.canceled) return;
    const sentences = this.splitter.push(token);
    for (const sentence of sentences) {
      this.schedule(sentence);
    }
  }

  async end(): Promise<void> {
    if (!this.canceled) {
      const tail = this.splitter.end();
      for (const sentence of tail) {
        this.schedule(sentence);
      }
    }
    // Drain — settle whatever is still outstanding.
    while (this.outstanding.size > 0) {
      await Promise.race(Array.from(this.outstanding));
    }
  }

  cancel(): void {
    this.canceled = true;
    // Release any waiters so they unblock and observe the canceled flag.
    while (this.permitWaiters.length > 0) {
      const w = this.permitWaiters.shift();
      if (w) {
        queueMicrotask(w);
      }
    }
  }

  /**
   * Test-only entry point that bypasses the splitter and treats `sentence` as
   * a ready-to-synthesize unit. Production code never calls this.
   */
  scheduleSentenceForTest(sentence: Sentence): void {
    this.schedule(sentence);
  }

  private schedule(sentence: Sentence): void {
    if (this.canceled) return;
    const seq = this.nextSeq++;
    const slot: PendingChunk = { seq, range: sentence.range };
    this.pending.push(slot);

    const task = this.runOne(sentence, slot);
    this.outstanding.add(task);
    const cleanup = () => {
      this.outstanding.delete(task);
    };
    task.then(cleanup).catch(cleanup);
  }

  private async runOne(sentence: Sentence, slot: PendingChunk): Promise<void> {
    await this.acquirePermit();
    try {
      if (this.canceled) {
        this.dropSlot(slot);
        return;
      }
      await this.processSentence(sentence, slot);
    } finally {
      this.releasePermit();
    }
  }

  private dropSlot(slot: PendingChunk): void {
    // Mark the slot ready-to-drop so drainEmit can skip past it without emitting.
    slot.resolved = { kind: 'dropped' };
    this.drainEmit();
  }

  private async acquirePermit(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.permitWaiters.push(resolve);
    });
    this.inFlight += 1;
  }

  private releasePermit(): void {
    this.inFlight -= 1;
    const next = this.permitWaiters.shift();
    if (next) {
      // Resolve on the microtask queue so the releasing task can wind down first.
      queueMicrotask(next);
    }
  }

  private async processSentence(sentence: Sentence, slot: PendingChunk): Promise<void> {
    if (this.canceled) {
      this.markFailed(slot);
      return;
    }

    const { provider, model, voice, speed, format, aiFilesRepo, storageWrite, sourceMessageRowId } = this.options;
    const sourceHash = computeTTSSourceHash({ text: sentence.text, model, voice, speed, format });

    try {
      const cached = await aiFilesRepo.findOne({ filter: { kind: 'tts-audio', sourceHash } });
      if (cached) {
        const url = this.extractUrl(cached);
        if (url) {
          this.markReady(slot, url);
          return;
        }
      }

      const stream = await this.synthesizeWithOneRetry({ provider, text: sentence.text, model, voice, speed, format });
      // Even if canceled during synthesize, finish persisting so replay can find the audio.
      const filename = `tts-${slot.seq}.${format}`;
      const written = await storageWrite(stream, filename);
      await aiFilesRepo.create({
        values: {
          kind: 'tts-audio',
          sourceHash,
          sourceMessageId: sourceMessageRowId ?? null,
          seq: slot.seq,
        },
      });
      this.markReady(slot, written.url);
    } catch (err) {
      if (err instanceof TTSRateLimitError || err instanceof TTSProviderError) {
        // Already handled inside synthesizeWithOneRetry retry path.
        this.markFailed(slot);
        return;
      }
      this.markFailed(slot);
    }
  }

  private async synthesizeWithOneRetry(args: {
    provider: TTSProvider;
    text: string;
    model: string;
    voice: string;
    speed: number;
    format: TTSAudioFormat;
  }): Promise<ReadableStream<Uint8Array>> {
    try {
      return await args.provider.synthesize({
        text: args.text,
        model: args.model,
        voice: args.voice,
        speed: args.speed,
        format: args.format,
      });
    } catch (err) {
      if (err instanceof TTSRateLimitError) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, err.retryAfterMs)));
        return await args.provider.synthesize({
          text: args.text,
          model: args.model,
          voice: args.voice,
          speed: args.speed,
          format: args.format,
        });
      }
      throw err;
    }
  }

  private extractUrl(row: unknown): string | undefined {
    if (row && typeof row === 'object') {
      const candidate = (row as Record<string, unknown>).url;
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
      const getter = (row as { get?: (k: string) => unknown }).get;
      if (typeof getter === 'function') {
        const got = getter.call(row, 'url');
        if (typeof got === 'string' && got.length > 0) return got;
      }
    }
    return undefined;
  }

  private markReady(slot: PendingChunk, url: string): void {
    slot.resolved = { kind: 'ok', url };
    this.drainEmit();
  }

  private markFailed(slot: PendingChunk): void {
    slot.resolved = { kind: 'failed' };
    this.drainEmit();
  }

  private drainEmit(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0];
      if (head.seq !== this.nextEmitSeq) return;
      if (!head.resolved) return;
      this.pending.shift();
      this.nextEmitSeq += 1;
      if (head.resolved.kind === 'ok') {
        this.options.sse.send('audio-chunk', {
          messageId: this.options.messageId,
          seq: head.seq,
          url: head.resolved.url,
          range: head.range,
        });
      } else if (head.resolved.kind === 'failed') {
        this.options.sse.send('audio-chunk-failed', {
          messageId: this.options.messageId,
          seq: head.seq,
          range: head.range,
        });
      }
      // 'dropped' — silently advance.
    }
  }
}
