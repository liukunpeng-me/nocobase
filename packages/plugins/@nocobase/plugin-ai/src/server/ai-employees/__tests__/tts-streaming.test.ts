/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { TTSProvider, TTSSynthesizeInput } from '@nocobase/ai';
import type { Repository } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { StreamingTTSCoordinator } from '../tts-streaming';
import { TTSStorageWrite } from '../tts-manager';

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

class StubProvider implements TTSProvider {
  calls: TTSSynthesizeInput[] = [];
  async synthesize(input: TTSSynthesizeInput): Promise<ReadableStream<Uint8Array>> {
    this.calls.push(input);
    return streamFromBytes(new Uint8Array([1]));
  }
}

function buildAiFilesRepo() {
  const rows: Record<string, unknown>[] = [];
  let nextId = 1000;
  return {
    rows,
    async findOne(_options: unknown) {
      return null;
    },
    async create(options: { values: Record<string, unknown> }) {
      const row = { id: nextId++, ...options.values };
      rows.push(row);
      return { ...row, get: (k: string) => (row as Record<string, unknown>)[k] };
    },
  } as unknown as Repository;
}

function buildSink() {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  return {
    events,
    sink: {
      send: (event: string, data: unknown) => {
        events.push({ event, data: data as Record<string, unknown> });
      },
    },
  };
}

describe('StreamingTTSCoordinator', () => {
  it('buffers tokens until noteMessageSaved fires, then replays through the pipeline', async () => {
    const provider = new StubProvider();
    const aiFilesRepo = buildAiFilesRepo();
    let storageCalls = 0;
    const storageWrite: TTSStorageWrite = async (stream, filename) => {
      // Drain the stream so the test isn't left with a pending ReadableStream.
      const reader = stream.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      storageCalls += 1;
      const id = storageCalls;
      return { id, url: `/api/aiFiles:download?id=${id}`, path: filename };
    };
    const { sink, events } = buildSink();
    const coordinator = new StreamingTTSCoordinator(
      {
        provider,
        config: { serviceName: 'svc', model: 'tts-1', voice: 'alloy', speed: 1 },
        aiFilesRepo,
        storageWrite,
      },
      sink,
    );

    coordinator.pushToken('Hello there friend. ');
    coordinator.pushToken('How are you doing today, buddy? ');
    // No synthesis yet — no message id known.
    expect(provider.calls).toHaveLength(0);
    expect(events.filter((e) => e.event === 'audio-chunk')).toHaveLength(0);

    coordinator.noteMessageSaved('42');
    coordinator.pushToken('And finally a third sentence to round it out!');
    await coordinator.end();

    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    const audio = events.filter((e) => e.event === 'audio-chunk');
    expect(audio.length).toBeGreaterThanOrEqual(1);
    for (const e of audio) {
      expect(e.data.messageId).toBe('42');
    }
  });

  it('is a no-op when runtime is null (TTS unavailable)', async () => {
    const { sink, events } = buildSink();
    const coordinator = new StreamingTTSCoordinator(null, sink);
    coordinator.pushToken('hello');
    coordinator.noteMessageSaved('1');
    coordinator.pushToken('world');
    coordinator.cancel();
    await coordinator.end();
    expect(events).toHaveLength(0);
  });

  it('cancel stops further scheduling even after noteMessageSaved', async () => {
    const provider = new StubProvider();
    const aiFilesRepo = buildAiFilesRepo();
    const storageWrite: TTSStorageWrite = async (stream) => {
      const reader = stream.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      return { id: 1, url: '/api/aiFiles:download?id=1' };
    };
    const { sink, events } = buildSink();
    const coordinator = new StreamingTTSCoordinator(
      {
        provider,
        config: { serviceName: 'svc', model: 'tts-1', voice: 'alloy', speed: 1 },
        aiFilesRepo,
        storageWrite,
      },
      sink,
    );
    coordinator.noteMessageSaved('99');
    coordinator.cancel();
    coordinator.pushToken('Hello there friend. ');
    await coordinator.end();
    expect(provider.calls).toHaveLength(0);
    expect(events.filter((e) => e.event === 'audio-chunk')).toHaveLength(0);
  });
});
