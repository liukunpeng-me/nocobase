/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useMessageTTS } from '../useMessageTTS';
import type { SSEAudioSource, SSEMessage } from '../../../../../shared/tts/sseAudioConsumer';

type EndedListener = () => void;

class FakeSource implements SSEAudioSource {
  private handlers = new Set<(msg: SSEMessage) => void>();
  onMessage(handler: (msg: SSEMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  emit(msg: SSEMessage): void {
    for (const h of Array.from(this.handlers)) h(msg);
  }
  get listenerCount(): number {
    return this.handlers.size;
  }
}

interface StubAudio {
  src: string;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, cb: EndedListener) => void;
  removeEventListener: (event: string, cb: EndedListener) => void;
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

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useMessageTTS', () => {
  let originalAudio: typeof globalThis.Audio | undefined;
  let stub: StubAudio;

  beforeEach(() => {
    stub = createStubAudio();
    originalAudio = (globalThis as { Audio?: typeof Audio }).Audio;
    (globalThis as unknown as { Audio: () => StubAudio }).Audio = function () {
      return stub;
    } as unknown as typeof Audio;
  });

  afterEach(() => {
    if (originalAudio) {
      (globalThis as { Audio?: typeof Audio }).Audio = originalAudio;
    } else {
      delete (globalThis as { Audio?: typeof Audio }).Audio;
    }
  });

  it('starts at idle, transitions through playing → done on happy path', async () => {
    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm1', sseSource: source, enabled: true }));

    expect(result.current.state).toBe('idle');

    await act(async () => {
      source.emit({
        event: 'audio-chunk',
        data: JSON.stringify({ messageId: 'm1', seq: 0, url: 'https://x/0.mp3', range: [0, 5] }),
      });
      await flushPromises();
    });

    expect(result.current.state).toBe('playing');
    expect(result.current.activeRange).toEqual([0, 5]);

    await act(async () => {
      stub.__fireEnded();
      await flushPromises();
    });

    expect(result.current.state).toBe('done');
  });

  it('reports blocked when play() rejects with NotAllowedError and retry restarts playback', async () => {
    const blockedErr = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    let callCount = 0;
    stub.play = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(blockedErr);
      }
      return Promise.resolve();
    });

    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm1', sseSource: source, enabled: true }));

    await act(async () => {
      source.emit({
        event: 'audio-chunk',
        data: JSON.stringify({ messageId: 'm1', seq: 0, url: 'https://x/0.mp3', range: [0, 5] }),
      });
      await flushPromises();
      await flushPromises();
    });

    expect(result.current.state).toBe('blocked');

    await act(async () => {
      result.current.retry();
      await flushPromises();
    });

    expect(result.current.state).toBe('playing');
  });

  it('stop() sets state to stopped and aborts the queue', async () => {
    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm1', sseSource: source, enabled: true }));

    await act(async () => {
      source.emit({
        event: 'audio-chunk',
        data: JSON.stringify({ messageId: 'm1', seq: 0, url: 'https://x/0.mp3', range: [0, 5] }),
      });
      await flushPromises();
    });

    await act(async () => {
      result.current.stop();
      await flushPromises();
    });

    expect(result.current.state).toBe('stopped');
  });

  it('audio-chunk-failed event marks the seq as failed', async () => {
    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm1', sseSource: source, enabled: true }));

    await act(async () => {
      source.emit({
        event: 'audio-chunk-failed',
        data: JSON.stringify({ messageId: 'm1', seq: 3, range: [10, 18] }),
      });
      await flushPromises();
    });

    expect(result.current.failedSeqs).toContain(3);
  });

  it('enabled === false prevents auto-start but stop is still callable', () => {
    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm1', sseSource: source, enabled: false }));

    act(() => {
      source.emit({
        event: 'audio-chunk',
        data: JSON.stringify({ messageId: 'm1', seq: 0, url: 'https://x/0.mp3', range: [0, 5] }),
      });
    });

    // Auto-start should not have happened: no playback started.
    expect(result.current.state).toBe('idle');
    expect(stub.play).not.toHaveBeenCalled();
    // calling stop() must not throw even when nothing has played yet.
    expect(() => {
      act(() => {
        result.current.stop();
      });
    }).not.toThrow();
  });
});
