/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioQueue } from '../../../../shared/tts/audioQueue';
import { consumeAudioChunks, SSEAudioSource, SSEMessage } from '../../../../shared/tts/sseAudioConsumer';

export type MessageTTSState = 'idle' | 'playing' | 'blocked' | 'done' | 'stopped' | 'unavailable';

export interface UseMessageTTSOptions {
  messageId: string;
  sseSource: SSEAudioSource;
  enabled: boolean;
}

export interface UseMessageTTSResult {
  state: MessageTTSState;
  activeRange: [number, number] | null;
  failedSeqs: number[];
  stop: () => void;
  retry: () => void;
}

interface FailedChunkPayload {
  messageId: string;
  seq: number;
  range?: [number, number];
}

const AUDIO_CHUNK_EVENT = 'audio-chunk';
const AUDIO_CHUNK_FAILED_EVENT = 'audio-chunk-failed';

const isFailedChunk = (value: unknown, messageId: string): value is FailedChunkPayload => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.seq === 'number' && v.messageId === messageId;
};

export function useMessageTTS(opts: UseMessageTTSOptions): UseMessageTTSResult {
  const { messageId, sseSource, enabled } = opts;
  const [state, setState] = useState<MessageTTSState>('idle');
  const [activeRange, setActiveRange] = useState<[number, number] | null>(null);
  const [failedSeqs, setFailedSeqs] = useState<number[]>([]);
  const queueRef = useRef<AudioQueue | null>(null);
  const startedRef = useRef(false);

  const queue = useMemo(() => new AudioQueue(), []);
  queueRef.current = queue;

  useEffect(() => {
    const off = queue.on((ev) => {
      if (ev.type === 'boundary' && ev.chunk.messageId === messageId) {
        setActiveRange(ev.chunk.range);
        setState('playing');
      } else if (ev.type === 'blocked') {
        setState('blocked');
      } else if (ev.type === 'done') {
        setState((prev) => (prev === 'stopped' ? prev : 'done'));
        setActiveRange(null);
      } else if (ev.type === 'stopped') {
        setState('stopped');
        setActiveRange(null);
      } else if (ev.type === 'error') {
        setFailedSeqs((prev) => (prev.includes(ev.seq) ? prev : [...prev, ev.seq]));
      }
    });
    return () => {
      off();
    };
  }, [queue, messageId]);

  useEffect(() => {
    const disposeConsumer = consumeAudioChunks(sseSource, queue);
    const disposeFailed = sseSource.onMessage((msg: SSEMessage) => {
      if (msg.event !== AUDIO_CHUNK_FAILED_EVENT) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!isFailedChunk(parsed, messageId)) return;
      setFailedSeqs((prev) => (prev.includes(parsed.seq) ? prev : [...prev, parsed.seq]));
    });

    // For the enabled-watching case: only the audio-chunk listener should auto-start.
    const disposeAutoStart = sseSource.onMessage((msg) => {
      if (msg.event !== AUDIO_CHUNK_EVENT) return;
      if (!enabled || startedRef.current) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const payload = parsed as { messageId?: unknown };
      if (payload.messageId !== messageId) return;
      startedRef.current = true;
      queue.start().catch(() => {
        // start() never rejects in normal cases — swallow to be safe.
      });
    });

    return () => {
      disposeConsumer();
      disposeFailed();
      disposeAutoStart();
    };
  }, [sseSource, queue, messageId, enabled]);

  useEffect(() => {
    return () => {
      queue.stop();
    };
  }, [queue]);

  const stop = useCallback(() => {
    queue.stop();
  }, [queue]);

  const retry = useCallback(() => {
    startedRef.current = true;
    queue.start().catch(() => {
      // ignore — handled via events.
    });
  }, [queue]);

  return { state, activeRange, failedSeqs, stop, retry };
}
