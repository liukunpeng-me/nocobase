/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AudioChunk, AudioQueue, AudioQueueEvent } from '../audioQueue';

type EndedListener = () => void;

interface StubAudio {
  src: string;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, cb: EndedListener) => void;
  removeEventListener: (event: string, cb: EndedListener) => void;
  /** test-only helper to fire `ended` */
  __fireEnded: () => void;
}

function createStubAudio(playImpl?: () => Promise<void>): StubAudio {
  const endedListeners = new Set<EndedListener>();
  const stub: StubAudio = {
    src: '',
    paused: true,
    play: vi.fn(playImpl ?? (() => Promise.resolve())),
    pause: vi.fn(() => {
      stub.paused = true;
    }),
    addEventListener: (event, cb) => {
      if (event === 'ended') endedListeners.add(cb);
    },
    removeEventListener: (event, cb) => {
      if (event === 'ended') endedListeners.delete(cb);
    },
    __fireEnded: () => {
      for (const cb of Array.from(endedListeners)) cb();
    },
  };
  return stub;
}

function makeChunk(seq: number): AudioChunk {
  return { seq, url: `https://example.com/${seq}.mp3`, range: [seq, seq + 1], messageId: 'm1' };
}

// Lets a microtask chain settle so the queue can advance after `play()` resolves.
async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('AudioQueue', () => {
  it('plays seq 0, 1, 2 in order and emits boundary then done', async () => {
    const stub = createStubAudio();
    const queue = new AudioQueue(() => stub as unknown as HTMLAudioElement);
    const events: AudioQueueEvent[] = [];
    queue.on((ev) => events.push(ev));

    queue.enqueue(makeChunk(0));
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2));

    const started = queue.start();

    // chunk 0
    await flush();
    expect(stub.src).toBe('https://example.com/0.mp3');
    expect(stub.play).toHaveBeenCalledTimes(1);
    stub.__fireEnded();

    // chunk 1
    await flush();
    expect(stub.src).toBe('https://example.com/1.mp3');
    expect(stub.play).toHaveBeenCalledTimes(2);
    stub.__fireEnded();

    // chunk 2
    await flush();
    expect(stub.src).toBe('https://example.com/2.mp3');
    expect(stub.play).toHaveBeenCalledTimes(3);
    stub.__fireEnded();

    await started;

    const boundarySeqs = events.filter((e) => e.type === 'boundary').map((e) => (e as { chunk: AudioChunk }).chunk.seq);
    expect(boundarySeqs).toEqual([0, 1, 2]);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('buffers out-of-order chunks until predecessors arrive', async () => {
    const stub = createStubAudio();
    const queue = new AudioQueue(() => stub as unknown as HTMLAudioElement);
    const events: AudioQueueEvent[] = [];
    queue.on((ev) => events.push(ev));

    // seq 2 arrives first
    queue.enqueue(makeChunk(2));

    const started = queue.start();
    await flush();

    // Nothing should have played yet — waiting on seq 1 (and 0, depending on the impl's start point).
    expect(stub.play).not.toHaveBeenCalled();

    queue.enqueue(makeChunk(1));
    await flush();
    expect(stub.play).not.toHaveBeenCalled();

    queue.enqueue(makeChunk(0));
    await flush();
    expect(stub.src).toBe('https://example.com/0.mp3');
    expect(stub.play).toHaveBeenCalledTimes(1);
    stub.__fireEnded();

    await flush();
    expect(stub.src).toBe('https://example.com/1.mp3');
    expect(stub.play).toHaveBeenCalledTimes(2);
    stub.__fireEnded();

    await flush();
    expect(stub.src).toBe('https://example.com/2.mp3');
    expect(stub.play).toHaveBeenCalledTimes(3);
    stub.__fireEnded();

    await started;

    const boundarySeqs = events.filter((e) => e.type === 'boundary').map((e) => (e as { chunk: AudioChunk }).chunk.seq);
    expect(boundarySeqs).toEqual([0, 1, 2]);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('emits blocked when play() rejects with NotAllowedError and retries on next start()', async () => {
    let rejectNext = true;
    const stub = createStubAudio(() => {
      if (rejectNext) {
        const err = new Error('autoplay blocked');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    });
    const queue = new AudioQueue(() => stub as unknown as HTMLAudioElement);
    const events: AudioQueueEvent[] = [];
    queue.on((ev) => events.push(ev));

    queue.enqueue(makeChunk(0));
    const firstStart = queue.start();

    await flush();
    await firstStart;

    expect(events.some((e) => e.type === 'blocked')).toBe(true);
    expect(stub.play).toHaveBeenCalledTimes(1);

    const playCallsBeforeRetry = stub.play.mock.calls.length;

    // Enqueueing more chunks while blocked should NOT trigger playback on its own.
    queue.enqueue(makeChunk(1));
    await flush();
    expect(stub.play).toHaveBeenCalledTimes(playCallsBeforeRetry);

    // Now unblock and retry: same chunk (seq 0) should play first.
    rejectNext = false;
    const secondStart = queue.start();

    await flush();
    expect(stub.src).toBe('https://example.com/0.mp3');
    stub.__fireEnded();

    await flush();
    expect(stub.src).toBe('https://example.com/1.mp3');
    stub.__fireEnded();

    await secondStart;

    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('emits stopped on stop() and suppresses subsequent events', async () => {
    const stub = createStubAudio();
    const queue = new AudioQueue(() => stub as unknown as HTMLAudioElement);
    const events: AudioQueueEvent[] = [];
    queue.on((ev) => events.push(ev));

    queue.enqueue(makeChunk(0));
    queue.enqueue(makeChunk(1));
    const started = queue.start();

    await flush();
    expect(stub.play).toHaveBeenCalledTimes(1);

    queue.stop();
    await flush();

    // Firing ended after stop should not advance the queue or emit further events.
    const eventCountAtStop = events.length;
    stub.__fireEnded();
    await flush();

    await started;

    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    expect(events.length).toBe(eventCountAtStop);
    expect(stub.src).toBe('');
  });

  it('ignores duplicate seq values', async () => {
    const stub = createStubAudio();
    const queue = new AudioQueue(() => stub as unknown as HTMLAudioElement);
    const events: AudioQueueEvent[] = [];
    queue.on((ev) => events.push(ev));

    queue.enqueue(makeChunk(0));
    queue.enqueue({ ...makeChunk(0), url: 'https://example.com/dup.mp3' });
    queue.enqueue(makeChunk(1));

    const started = queue.start();

    await flush();
    expect(stub.src).toBe('https://example.com/0.mp3');
    stub.__fireEnded();

    await flush();
    expect(stub.src).toBe('https://example.com/1.mp3');
    stub.__fireEnded();

    await started;

    const boundarySeqs = events.filter((e) => e.type === 'boundary').map((e) => (e as { chunk: AudioChunk }).chunk.seq);
    expect(boundarySeqs).toEqual([0, 1]);
    // Duplicate must not flip the URL the second time around.
    expect(stub.play).toHaveBeenCalledTimes(2);
  });

  it('disposer returned from on() stops further notifications', async () => {
    const stub = createStubAudio();
    const queue = new AudioQueue(() => stub as unknown as HTMLAudioElement);
    const events: AudioQueueEvent[] = [];
    const off = queue.on((ev) => events.push(ev));

    queue.enqueue(makeChunk(0));
    const started = queue.start();

    await flush();
    off();
    stub.__fireEnded();
    await started;

    // The boundary fired before we disposed, so it should be there;
    // the done event fired after disposal, so it should NOT be.
    expect(events.some((e) => e.type === 'boundary')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
