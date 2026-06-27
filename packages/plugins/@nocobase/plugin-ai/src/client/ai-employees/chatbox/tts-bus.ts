/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { SSEAudioSource, SSEMessage } from '../../../../shared/tts/sseAudioConsumer';

type Handler = (msg: SSEMessage) => void;

/**
 * Per-session pub/sub bus for TTS-related SSE events that arrive on the
 * existing aiConversations:sendMessages stream. The chat stream parser
 * forwards audio-chunk / audio-chunk-failed events here; useMessageTTS
 * subscribes per message.
 *
 * This is intentionally a tiny module with no external deps — it lives
 * outside any store framework so it can be imported from anywhere without
 * coupling to v1- or v2-specific state.
 */
class TTSBus implements SSEAudioSource {
  private handlers = new Set<Handler>();

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(msg: SSEMessage): void {
    for (const h of Array.from(this.handlers)) h(msg);
  }
}

const buses = new Map<string, TTSBus>();

export function getTTSBus(sessionId: string | undefined | null): TTSBus {
  const key = sessionId || '__default__';
  let bus = buses.get(key);
  if (!bus) {
    bus = new TTSBus();
    buses.set(key, bus);
  }
  return bus;
}

/**
 * Inspect a single parsed stream line. If it carries TTS payload, emit
 * an SSEMessage to the per-session bus. The chat stream parser calls
 * this for every parsed JSON line — calling it for non-TTS lines is a
 * no-op.
 */
export function routeTTSStreamLine(sessionId: string, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const v = data as Record<string, unknown>;
  const type = v.type;
  if (type !== 'audio-chunk' && type !== 'audio-chunk-failed') return;
  const body = v.body;
  if (!body || typeof body !== 'object') return;
  const bus = getTTSBus(sessionId);
  bus.emit({ event: String(type), data: JSON.stringify(body) });
}
