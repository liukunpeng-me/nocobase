/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type TTSAudioFormat = 'mp3' | 'opus';

export interface TTSSynthesizeInput {
  text: string;
  model: string;
  voice: string;
  speed: number;
  format: TTSAudioFormat;
}

export interface TTSProvider {
  synthesize(input: TTSSynthesizeInput): Promise<ReadableStream<Uint8Array>>;
}

export interface TTSRateLimitErrorOptions {
  retryAfterMs: number;
  message?: string;
}

export class TTSRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(options: TTSRateLimitErrorOptions) {
    super(options.message ?? `TTS provider rate limited (retry after ${options.retryAfterMs}ms)`);
    this.name = 'TTSRateLimitError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface TTSProviderErrorOptions {
  status: number;
  bodyExcerpt: string;
  message?: string;
}

export class TTSProviderError extends Error {
  readonly status: number;
  readonly bodyExcerpt: string;

  constructor(options: TTSProviderErrorOptions) {
    super(options.message ?? `TTS provider error (status ${options.status})`);
    this.name = 'TTSProviderError';
    this.status = options.status;
    this.bodyExcerpt = options.bodyExcerpt;
  }
}
