/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageTTS } from '../chatbox/hooks/useMessageTTS';
import type { SSEAudioSource, SSEMessage } from '../../../shared/tts/sseAudioConsumer';

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

function createStubAudio(): StubAudio {
  const endedListeners = new Set<EndedListener>();
  const stub: StubAudio = {
    src: '',
    paused: true,
    play: vi.fn(() => Promise.resolve()),
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

describe('v2 useMessageTTS', () => {
  let stub: StubAudio;
  let originalAudio: typeof globalThis.Audio | undefined;

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

  it('happy path: enabled, auto-starts on first chunk, transitions playing → done', async () => {
    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm-v2', sseSource: source, enabled: true }));

    expect(result.current.state).toBe('idle');

    await act(async () => {
      source.emit({
        event: 'audio-chunk',
        data: JSON.stringify({ messageId: 'm-v2', seq: 0, url: 'https://x/0.mp3', range: [0, 5] }),
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

  it('does not auto-start when enabled is false', () => {
    const source = new FakeSource();
    const { result } = renderHook(() => useMessageTTS({ messageId: 'm-v2', sseSource: source, enabled: false }));
    act(() => {
      source.emit({
        event: 'audio-chunk',
        data: JSON.stringify({ messageId: 'm-v2', seq: 0, url: 'https://x/0.mp3', range: [0, 5] }),
      });
    });
    expect(result.current.state).toBe('idle');
    expect(stub.play).not.toHaveBeenCalled();
  });
});
