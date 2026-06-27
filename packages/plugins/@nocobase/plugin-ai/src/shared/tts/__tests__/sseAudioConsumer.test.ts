/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AudioChunk, AudioQueue } from '../audioQueue';
import { consumeAudioChunks, SSEMessage } from '../sseAudioConsumer';

class FakeSource {
  private handlers = new Set<(msg: SSEMessage) => void>();
  onMessage(handler: (msg: SSEMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(msg: SSEMessage): void {
    for (const h of Array.from(this.handlers)) h(msg);
  }
  get listenerCount(): number {
    return this.handlers.size;
  }
}

function createMockQueue(): AudioQueue & { __enqueued: AudioChunk[] } {
  const enqueued: AudioChunk[] = [];
  const queue = {
    enqueue: (chunk: AudioChunk) => enqueued.push(chunk),
    __enqueued: enqueued,
  };
  return queue as unknown as AudioQueue & { __enqueued: AudioChunk[] };
}

describe('consumeAudioChunks', () => {
  it('enqueues a chunk that matches the audio-chunk payload', () => {
    const source = new FakeSource();
    const queue = createMockQueue();
    consumeAudioChunks(source, queue);

    const payload: AudioChunk = { seq: 0, url: 'https://x/0.mp3', range: [0, 12], messageId: 'm1' };
    source.emit({ event: 'audio-chunk', data: JSON.stringify(payload) });

    expect(queue.__enqueued).toEqual([payload]);
  });

  it('ignores events with a different event name', () => {
    const source = new FakeSource();
    const queue = createMockQueue();
    consumeAudioChunks(source, queue);

    source.emit({ event: 'message', data: JSON.stringify({ seq: 0, url: 'x', range: [0, 1], messageId: 'm' }) });
    source.emit({ event: 'audio-end', data: '{}' });

    expect(queue.__enqueued).toEqual([]);
  });

  it('silently ignores malformed JSON without throwing', () => {
    const source = new FakeSource();
    const queue = createMockQueue();
    consumeAudioChunks(source, queue);

    expect(() => {
      source.emit({ event: 'audio-chunk', data: '{not valid json' });
    }).not.toThrow();
    expect(queue.__enqueued).toEqual([]);
  });

  it('disposer unsubscribes from the source', () => {
    const source = new FakeSource();
    const queue = createMockQueue();
    const dispose = consumeAudioChunks(source, queue);

    expect(source.listenerCount).toBe(1);

    dispose();
    expect(source.listenerCount).toBe(0);

    const payload: AudioChunk = { seq: 0, url: 'https://x/0.mp3', range: [0, 12], messageId: 'm1' };
    source.emit({ event: 'audio-chunk', data: JSON.stringify(payload) });
    expect(queue.__enqueued).toEqual([]);
  });
});
