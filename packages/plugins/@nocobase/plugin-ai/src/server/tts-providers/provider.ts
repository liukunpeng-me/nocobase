/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { TTSProvider, TTSProviderError, TTSRateLimitError, TTSSynthesizeInput } from '@nocobase/ai';

export interface BaseTTSProviderOptions {
  apiKey: string;
  baseURL?: string;
}

const BODY_EXCERPT_MAX = 500;
const RETRY_AFTER_DEFAULT_SECONDS = 1;

export abstract class BaseTTSProvider implements TTSProvider {
  protected readonly apiKey: string;
  protected readonly baseURL: string;

  constructor(opts: BaseTTSProviderOptions) {
    if (!opts.apiKey) {
      throw new Error('TTS provider apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.baseURL = this.normalizeBaseURL(opts.baseURL ?? this.getDefaultBaseURL());
  }

  abstract getDefaultBaseURL(): string;

  protected abstract getRequestPath(): string;

  protected abstract buildBody(input: TTSSynthesizeInput): Record<string, unknown>;

  async synthesize(input: TTSSynthesizeInput): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildRequestURL(this.getRequestPath());
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(input)),
    });

    if (response.status === 200) {
      const stream = response.body;
      if (!stream) {
        throw new TTSProviderError({
          status: response.status,
          bodyExcerpt: 'TTS provider returned 200 without a response body',
        });
      }
      return stream;
    }

    if (response.status === 429) {
      const retryAfterMs = this.parseRetryAfterMs(response);
      throw new TTSRateLimitError({ retryAfterMs });
    }

    const bodyExcerpt = await this.readBodyExcerpt(response);
    throw new TTSProviderError({ status: response.status, bodyExcerpt });
  }

  protected buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  protected buildRequestURL(pathname: string): string {
    const trimmed = pathname.replace(/^\/+/, '');
    return `${this.baseURL}/${trimmed}`;
  }

  protected normalizeBaseURL(baseURL: string): string {
    return baseURL.replace(/\/+$/, '');
  }

  protected parseRetryAfterMs(response: Response): number {
    const header = response.headers.get('Retry-After');
    if (!header) {
      return RETRY_AFTER_DEFAULT_SECONDS * 1000;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const dateValue = Date.parse(header);
    if (!Number.isNaN(dateValue)) {
      const delta = dateValue - Date.now();
      return delta > 0 ? delta : RETRY_AFTER_DEFAULT_SECONDS * 1000;
    }
    return RETRY_AFTER_DEFAULT_SECONDS * 1000;
  }

  protected async readBodyExcerpt(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, BODY_EXCERPT_MAX);
    } catch {
      return '';
    }
  }
}
