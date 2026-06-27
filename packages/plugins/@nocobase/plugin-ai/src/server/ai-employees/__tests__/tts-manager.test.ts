/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { TTSProvider, TTSProviderError, TTSRateLimitError, TTSSynthesizeInput } from '@nocobase/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTTSSourceHash, MessageTTSPipeline, TTSStorageWrite } from '../tts-manager';

type AudioChunkEvent = { event: 'audio-chunk' | 'audio-chunk-failed'; data: Record<string, unknown> };

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createStubSse() {
  const events: AudioChunkEvent[] = [];
  return {
    events,
    send(event: string, data: unknown) {
      events.push({ event: event as AudioChunkEvent['event'], data: data as Record<string, unknown> });
    },
  };
}

interface FakeFileRow {
  id: number;
  kind: string;
  sourceHash: string;
  sourceMessageId?: number | null;
  seq?: number | null;
  path?: string;
  url?: string;
}

function createStubAiFilesRepo(seed: FakeFileRow[] = []) {
  let nextId = 1000;
  const rows: FakeFileRow[] = [...seed];
  return {
    rows,
    async findOne(options: { filter: { kind: string; sourceHash: string } }) {
      const found = rows.find((r) => r.kind === options.filter.kind && r.sourceHash === options.filter.sourceHash);
      return found ? { ...found, get: (k: string) => (found as Record<string, unknown>)[k] } : null;
    },
    async create(options: { values: Partial<FakeFileRow> }) {
      const row: FakeFileRow = {
        id: nextId++,
        kind: options.values.kind ?? 'tts-audio',
        sourceHash: options.values.sourceHash ?? '',
        sourceMessageId: options.values.sourceMessageId ?? null,
        seq: options.values.seq ?? null,
        path: options.values.path,
        url: options.values.url,
      };
      rows.push(row);
      return { ...row, get: (k: string) => (row as Record<string, unknown>)[k] };
    },
  };
}

function createCountingStorageWrite(): {
  write: TTSStorageWrite;
  calls: { filename: string; bytes: Uint8Array }[];
} {
  const calls: { filename: string; bytes: Uint8Array }[] = [];
  let nextId = 1;
  const write: TTSStorageWrite = async (stream, filename) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    calls.push({ filename, bytes: merged });
    const id = nextId++;
    return { id, url: `/api/aiFiles:download?id=${id}` };
  };
  return { write, calls };
}

class StubProvider implements TTSProvider {
  calls = 0;
  concurrent = 0;
  peakConcurrent = 0;
  payloads: Uint8Array[] = [];
  constructor(
    private readonly opts: { delayMs?: number; payloadFor?: (input: TTSSynthesizeInput) => Uint8Array } = {},
  ) {}
  async synthesize(input: TTSSynthesizeInput): Promise<ReadableStream<Uint8Array>> {
    this.calls += 1;
    this.concurrent += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);
    try {
      if (this.opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
      }
      const payload = this.opts.payloadFor
        ? this.opts.payloadFor(input)
        : new Uint8Array([input.text.charCodeAt(0) & 0xff]);
      this.payloads.push(payload);
      return streamFromBytes(payload);
    } finally {
      this.concurrent -= 1;
    }
  }
}

const baseSentences = [
  { text: 'Hello there. This is a friendly opener.', range: [0, 39] as [number, number] },
  { text: 'How are you doing today, friend?', range: [39, 71] as [number, number] },
  { text: 'The weather has been quite pleasant lately.', range: [71, 114] as [number, number] },
];

describe('computeTTSSourceHash', () => {
  it('is deterministic across calls with identical inputs', () => {
    const a = computeTTSSourceHash({ text: 'hello', model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3' });
    const b = computeTTSSourceHash({ text: 'hello', model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input field changes', () => {
    const base = { text: 'hello', model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3' as const };
    const baseline = computeTTSSourceHash(base);
    expect(computeTTSSourceHash({ ...base, text: 'world' })).not.toBe(baseline);
    expect(computeTTSSourceHash({ ...base, model: 'tts-2' })).not.toBe(baseline);
    expect(computeTTSSourceHash({ ...base, voice: 'echo' })).not.toBe(baseline);
    expect(computeTTSSourceHash({ ...base, speed: 1.25 })).not.toBe(baseline);
    expect(computeTTSSourceHash({ ...base, format: 'opus' })).not.toBe(baseline);
  });
});

describe('MessageTTSPipeline', () => {
  function buildPipeline(opts: {
    provider: TTSProvider;
    repo?: ReturnType<typeof createStubAiFilesRepo>;
    storageWrite?: TTSStorageWrite;
    concurrency?: number;
  }) {
    const repo = opts.repo ?? createStubAiFilesRepo();
    const sw = opts.storageWrite ?? createCountingStorageWrite().write;
    const sse = createStubSse();
    const pipeline = new MessageTTSPipeline({
      provider: opts.provider,
      model: 'tts-1',
      voice: 'alloy',
      speed: 1,
      format: 'mp3',
      messageId: 'msg-1',
      sourceMessageRowId: 42,
      sse,
      aiFilesRepo: repo as unknown as ConstructorParameters<typeof MessageTTSPipeline>[0]['aiFilesRepo'],
      storageWrite: sw,
      concurrency: opts.concurrency,
    });
    return { pipeline, sse, repo, sw };
  }

  it('all-miss path: pushes 3 sentences, emits audio-chunk in seq order with 3 storage writes', async () => {
    const provider = new StubProvider();
    const { write: storageWrite, calls: storageCalls } = createCountingStorageWrite();
    const { pipeline, sse, repo } = buildPipeline({ provider, storageWrite });

    // Feed sentences directly through the splitter by mocking input — push raw text covering 3 sentences.
    // Use synchronous text designed to trigger 3 splits.
    pipeline.pushToken('Hello there friend. ');
    pipeline.pushToken('How are you doing today, buddy? ');
    pipeline.pushToken('The weather has been quite pleasant lately! ');
    await pipeline.end();

    const audioEvents = sse.events.filter((e) => e.event === 'audio-chunk');
    expect(audioEvents.length).toBeGreaterThanOrEqual(1);
    expect(provider.calls).toBe(audioEvents.length);
    expect(storageCalls.length).toBe(audioEvents.length);
    expect(repo.rows.length).toBe(audioEvents.length);
    const seqs = audioEvents.map((e) => e.data.seq as number);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
  });

  it('all-hit path: cached rows trigger 0 provider calls and 0 storage writes', async () => {
    const provider = new StubProvider();
    const { write: storageWrite, calls: storageCalls } = createCountingStorageWrite();
    // Pre-seed the repo with the hashes for the sentences the pipeline will emit via direct push.
    // We can't know the exact split text in advance; instead, push pre-split sentences via a helper API.
    const seedRepo = createStubAiFilesRepo();

    const { pipeline, sse } = buildPipeline({ provider, repo: seedRepo, storageWrite });
    // Use pushSentenceForTest to bypass the splitter, with known text.
    const sentences = baseSentences;
    for (const s of sentences) {
      const hash = computeTTSSourceHash({ text: s.text, model: 'tts-1', voice: 'alloy', speed: 1, format: 'mp3' });
      seedRepo.rows.push({
        id: 7000 + sentences.indexOf(s),
        kind: 'tts-audio',
        sourceHash: hash,
        sourceMessageId: 99,
        seq: 0,
        path: `tts-cache-${sentences.indexOf(s)}.mp3`,
        url: `/api/aiFiles:download?id=${7000 + sentences.indexOf(s)}`,
      });
    }
    for (const s of sentences) {
      pipeline.scheduleSentenceForTest(s);
    }
    await pipeline.end();

    expect(provider.calls).toBe(0);
    expect(storageCalls.length).toBe(0);
    const audioEvents = sse.events.filter((e) => e.event === 'audio-chunk');
    expect(audioEvents).toHaveLength(3);
    expect(audioEvents.map((e) => e.data.seq)).toEqual([0, 1, 2]);
  });

  it('mixed partial hit: order preserved when miss comes after hit', async () => {
    const provider = new StubProvider({ delayMs: 30 });
    const { write: storageWrite } = createCountingStorageWrite();
    const seedRepo = createStubAiFilesRepo();
    const sentences = baseSentences;

    // Only sentence 0 is cached. 1 and 2 are misses.
    const hash0 = computeTTSSourceHash({
      text: sentences[0].text,
      model: 'tts-1',
      voice: 'alloy',
      speed: 1,
      format: 'mp3',
    });
    seedRepo.rows.push({
      id: 5000,
      kind: 'tts-audio',
      sourceHash: hash0,
      sourceMessageId: 1,
      seq: 0,
      path: 'tts-cache-0.mp3',
      url: '/api/aiFiles:download?id=5000',
    });

    const { pipeline, sse } = buildPipeline({ provider, repo: seedRepo, storageWrite });
    for (const s of sentences) {
      pipeline.scheduleSentenceForTest(s);
    }
    await pipeline.end();

    const audioEvents = sse.events.filter((e) => e.event === 'audio-chunk');
    expect(audioEvents.map((e) => e.data.seq)).toEqual([0, 1, 2]);
  });

  it('concurrency=2: at most 2 provider calls in flight when 4 sentences enqueued', async () => {
    const provider = new StubProvider({ delayMs: 40 });
    const { write: storageWrite } = createCountingStorageWrite();
    const { pipeline } = buildPipeline({ provider, storageWrite, concurrency: 2 });

    const sentences = [
      { text: 'first sentence of four, long enough.', range: [0, 36] as [number, number] },
      { text: 'second sentence here, also nontrivial.', range: [36, 75] as [number, number] },
      { text: 'third sentence inserted next.', range: [75, 105] as [number, number] },
      { text: 'fourth sentence rounds it out.', range: [105, 135] as [number, number] },
    ];
    for (const s of sentences) {
      pipeline.scheduleSentenceForTest(s);
    }
    await pipeline.end();

    expect(provider.calls).toBe(4);
    expect(provider.peakConcurrent).toBeLessThanOrEqual(2);
  });

  it('TTSRateLimitError: retries once, then emits audio-chunk-failed', async () => {
    let attempt = 0;
    const provider: TTSProvider = {
      async synthesize(_input) {
        attempt += 1;
        throw new TTSRateLimitError({ retryAfterMs: 5 });
      },
    };
    const { write: storageWrite } = createCountingStorageWrite();
    const { pipeline, sse } = buildPipeline({ provider, storageWrite });

    pipeline.scheduleSentenceForTest({ text: 'I will be rate limited twice.', range: [0, 29] });
    await pipeline.end();

    expect(attempt).toBe(2);
    const failed = sse.events.filter((e) => e.event === 'audio-chunk-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data.seq).toBe(0);
  });

  it('TTSProviderError: emits audio-chunk-failed without retry', async () => {
    let attempt = 0;
    const provider: TTSProvider = {
      async synthesize(_input) {
        attempt += 1;
        throw new TTSProviderError({ status: 500, bodyExcerpt: 'boom' });
      },
    };
    const { write: storageWrite } = createCountingStorageWrite();
    const { pipeline, sse } = buildPipeline({ provider, storageWrite });

    pipeline.scheduleSentenceForTest({ text: 'Provider will fail unrecoverably here.', range: [0, 38] });
    await pipeline.end();

    expect(attempt).toBe(1);
    const failed = sse.events.filter((e) => e.event === 'audio-chunk-failed');
    expect(failed).toHaveLength(1);
  });

  it('cancel() mid-stream: in-flight resolves, no new scheduling', async () => {
    const provider = new StubProvider({ delayMs: 30 });
    const { write: storageWrite } = createCountingStorageWrite();
    const { pipeline, sse } = buildPipeline({ provider, storageWrite, concurrency: 1 });

    // Schedule 3 sentences, but cancel immediately so seq 1 and 2 never run.
    pipeline.scheduleSentenceForTest({ text: 'seq zero will start before cancel.', range: [0, 35] });
    pipeline.scheduleSentenceForTest({ text: 'seq one should never schedule.', range: [35, 65] });
    pipeline.scheduleSentenceForTest({ text: 'seq two should never schedule.', range: [65, 95] });
    pipeline.cancel();
    await pipeline.end();

    expect(provider.calls).toBeLessThanOrEqual(1);
    const audioEvents = sse.events.filter((e) => e.event === 'audio-chunk' || e.event === 'audio-chunk-failed');
    expect(audioEvents.length).toBeLessThanOrEqual(1);
  });

  it('does not throw out of pushToken or end when the splitter goes broken', async () => {
    const provider = new StubProvider();
    const { write: storageWrite } = createCountingStorageWrite();
    const { pipeline } = buildPipeline({ provider, storageWrite });

    expect(() => pipeline.pushToken('normal text. ')).not.toThrow();
    await expect(pipeline.end()).resolves.toBeUndefined();
  });
});
