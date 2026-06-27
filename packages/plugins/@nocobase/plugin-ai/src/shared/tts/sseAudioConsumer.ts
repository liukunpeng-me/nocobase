/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AudioChunk, AudioQueue } from './audioQueue';

export interface SSEMessage {
  event: string;
  data: string;
}

export interface SSEAudioSource {
  onMessage(handler: (msg: SSEMessage) => void): () => void;
}

const AUDIO_CHUNK_EVENT = 'audio-chunk';

const isAudioChunk = (value: unknown): value is AudioChunk => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== 'number') return false;
  if (typeof v.url !== 'string') return false;
  if (typeof v.messageId !== 'string') return false;
  const range = v.range;
  if (!Array.isArray(range) || range.length !== 2) return false;
  return typeof range[0] === 'number' && typeof range[1] === 'number';
};

export function consumeAudioChunks(source: SSEAudioSource, queue: AudioQueue): () => void {
  return source.onMessage((msg) => {
    if (msg.event !== AUDIO_CHUNK_EVENT) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (!isAudioChunk(parsed)) return;
    queue.enqueue(parsed);
  });
}
