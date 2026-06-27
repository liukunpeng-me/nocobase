/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { TTSProvider, TTSProviderError, TTSSynthesizeInput } from '@nocobase/ai';
import { describe, expect, it } from 'vitest';
import { runReplay, RunReplayDeps } from '../aiTTS';
import { computeTTSSourceHash } from '../../ai-employees/tts-manager';
import { SentenceSplitter } from '../../ai-employees/sentence-splitter';

interface FakeRow {
  [k: string]: unknown;
  toJSON?: () => Record<string, unknown>;
}

function wrap(row: Record<string, unknown>): FakeRow {
  return { ...row, toJSON: () => row, get: (k: string) => row[k] };
}

function buildStubRepo(rows: Record<string, unknown>[]) {
  return {
    rows,
    async findOne(options: { filter?: Record<string, unknown> } = {}) {
      const filter = options.filter ?? {};
      const found = rows.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
      return found ? wrap(found) : null;
    },
  };
}

function buildAiFilesRepo(seed: Record<string, unknown>[] = []) {
  let nextId = 9000;
  const rows = [...seed];
  return {
    rows,
    async findOne(options: { filter: Record<string, unknown> }) {
      const found = rows.find((r) => Object.entries(options.filter).every(([k, v]) => r[k] === v));
      return found ? wrap(found) : null;
    },
    async create(options: { values: Record<string, unknown> }) {
      const row = { id: nextId++, ...options.values };
      rows.push(row);
      return wrap(row);
    },
  } as unknown as RunReplayDeps['aiFilesRepo'];
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

class StubProvider implements TTSProvider {
  calls = 0;
  async synthesize(input: TTSSynthesizeInput): Promise<ReadableStream<Uint8Array>> {
    this.calls += 1;
    return streamFromBytes(new Uint8Array([input.text.charCodeAt(0) & 0xff]));
  }
}

const replayText =
  'Hello there. This is the first sentence! And this is the second one. Finally a third sentence to round it out.';

function buildBaseDeps(overrides: Partial<RunReplayDeps> = {}): RunReplayDeps & {
  sseEvents: { event: string; data: Record<string, unknown> }[];
  storageCalls: { filename: string }[];
} {
  const sseEvents: { event: string; data: Record<string, unknown> }[] = [];
  const storageCalls: { filename: string }[] = [];
  let storageId = 1;
  const sse = {
    send: (event: string, data: unknown) => {
      sseEvents.push({ event, data: data as Record<string, unknown> });
    },
  };
  const deps: RunReplayDeps = {
    aiMessagesRepo: buildStubRepo([{ messageId: 42, role: 'alice', content: { type: 'text', content: replayText } }]),
    aiEmployeesRepo: buildStubRepo([{ username: 'alice', voiceSettings: { voice: 'nova' } }]),
    usersAiEmployeesRepo: buildStubRepo([]),
    aiSettingsRepo: buildStubRepo([
      {
        defaultTTSServiceName: 'openai-tts',
        defaultTTSModel: 'tts-1',
        defaultTTSVoice: 'alloy',
        defaultTTSSpeed: 1,
      },
    ]),
    llmServicesRepo: buildStubRepo([
      {
        name: 'openai-tts',
        provider: 'openai',
        purpose: 'tts',
        options: { apiKey: 'sk-test' },
      },
    ]),
    aiFilesRepo: buildAiFilesRepo(),
    sse,
    storageWrite: async (_stream, filename) => {
      storageCalls.push({ filename });
      const id = storageId++;
      return { id, url: `/api/aiFiles:download?id=${id}` };
    },
    getProvider: () => new StubProvider(),
    ...overrides,
  };
  return Object.assign(deps, { sseEvents, storageCalls });
}

describe('aiTTS resource — runReplay', () => {
  it('streams audio-chunk events in seq order with the standard URL shape', async () => {
    const deps = buildBaseDeps();
    await runReplay(42, deps);

    const audio = deps.sseEvents.filter((e) => e.event === 'audio-chunk');
    expect(audio.length).toBeGreaterThanOrEqual(1);
    const seqs = audio.map((e) => e.data.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (const e of audio) {
      expect(String(e.data.url)).toMatch(/^\/api\/aiFiles:download\?id=\d+$/);
    }
  });

  it('hits the cache for previously-seen sourceHash and emits without a storage write', async () => {
    // Compute the actual first sentence by running the same splitter the pipeline uses.
    const splitter = new SentenceSplitter();
    const firstSentences = splitter.push(replayText);
    splitter.end();
    expect(firstSentences.length).toBeGreaterThanOrEqual(1);
    const cachedHash = computeTTSSourceHash({
      text: firstSentences[0].text,
      model: 'tts-1',
      voice: 'nova',
      speed: 1,
      format: 'mp3',
    });
    const deps = buildBaseDeps({
      aiFilesRepo: buildAiFilesRepo([
        {
          kind: 'tts-audio',
          sourceHash: cachedHash,
          url: '/api/aiFiles:download?id=777',
        },
      ]),
    });
    await runReplay(42, deps);

    const audio = deps.sseEvents.filter((e) => e.event === 'audio-chunk');
    expect(audio.length).toBeGreaterThanOrEqual(1);
    // The first chunk should be the cached URL (matches first sentence).
    expect(audio[0].data.url).toBe('/api/aiFiles:download?id=777');
  });

  it('propagates audio-chunk-failed when the provider raises a TTSProviderError', async () => {
    const failingProvider: TTSProvider = {
      async synthesize(_input) {
        throw new TTSProviderError({ status: 500, bodyExcerpt: 'fail' });
      },
    };
    const deps = buildBaseDeps({ getProvider: () => failingProvider });
    await runReplay(42, deps);

    const failed = deps.sseEvents.filter((e) => e.event === 'audio-chunk-failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a single failure when the message is missing', async () => {
    const deps = buildBaseDeps({ aiMessagesRepo: buildStubRepo([]) });
    await runReplay(99, deps);
    expect(deps.sseEvents.filter((e) => e.event === 'audio-chunk-failed')).toHaveLength(1);
    expect(deps.storageCalls).toHaveLength(0);
  });

  it('emits a single failure when the resolved service is missing purpose=tts', async () => {
    const deps = buildBaseDeps({
      llmServicesRepo: buildStubRepo([
        { name: 'openai-tts', provider: 'openai', purpose: 'llm', options: { apiKey: 'sk-test' } },
      ]),
    });
    await runReplay(42, deps);
    const failed = deps.sseEvents.filter((e) => e.event === 'audio-chunk-failed');
    expect(failed).toHaveLength(1);
  });
});
