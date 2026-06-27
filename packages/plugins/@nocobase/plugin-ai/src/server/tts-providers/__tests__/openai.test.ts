/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTSProviderError, TTSRateLimitError, TTSSynthesizeInput } from '@nocobase/ai';
import { OpenAITTSProvider } from '../openai';

type FetchMock = ReturnType<typeof vi.fn>;

function buildResponse(opts: {
  status: number;
  body?: ReadableStream<Uint8Array> | string | null;
  headers?: Record<string, string>;
  statusText?: string;
}): Response {
  const { status, body, headers = {}, statusText } = opts;
  if (body instanceof ReadableStream) {
    return new Response(body, { status, headers, statusText });
  }
  return new Response(body ?? null, { status, headers, statusText });
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const baseInput: TTSSynthesizeInput = {
  text: 'hello world',
  model: 'tts-1',
  voice: 'alloy',
  speed: 1,
  format: 'mp3',
};

describe('OpenAITTSProvider', () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    vi.restoreAllMocks();
  });

  it('sends correctly shaped POST request to default base URL', async () => {
    const payload = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3" mp3 marker
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        status: 200,
        body: streamFromBytes(payload),
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    );

    const provider = new OpenAITTSProvider({ apiKey: 'sk-test' });
    await provider.synthesize(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.openai.com/v1/audio/speech');
    expect(calledInit.method).toBe('POST');
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(calledInit.body as string);
    expect(body).toEqual({
      model: 'tts-1',
      voice: 'alloy',
      input: 'hello world',
      response_format: 'mp3',
      speed: 1,
    });
  });

  it('honours a custom baseURL and trims trailing slashes', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        status: 200,
        body: streamFromBytes(new Uint8Array([0])),
      }),
    );

    const provider = new OpenAITTSProvider({
      apiKey: 'sk-test',
      baseURL: 'https://proxy.example.com/v1/',
    });
    await provider.synthesize(baseInput);

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://proxy.example.com/v1/audio/speech');
  });

  it('returns a ReadableStream on 200 and emits the mocked bytes', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        status: 200,
        body: streamFromBytes(payload),
      }),
    );

    const provider = new OpenAITTSProvider({ apiKey: 'sk-test' });
    const stream = await provider.synthesize(baseInput);

    expect(stream).toBeInstanceOf(ReadableStream);
    const received = await readAllBytes(stream);
    expect(Array.from(received)).toEqual(Array.from(payload));
  });

  it('converts 429 with Retry-After: 2 into TTSRateLimitError with retryAfterMs === 2000', async () => {
    const rateLimitedResponse = () =>
      buildResponse({
        status: 429,
        body: 'rate limited',
        headers: { 'Retry-After': '2' },
      });
    fetchMock.mockResolvedValueOnce(rateLimitedResponse()).mockResolvedValueOnce(rateLimitedResponse());

    const provider = new OpenAITTSProvider({ apiKey: 'sk-test' });
    await expect(provider.synthesize(baseInput)).rejects.toMatchObject({
      retryAfterMs: 2000,
    });

    let caught: unknown;
    try {
      await provider.synthesize({ ...baseInput });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TTSRateLimitError);
  });

  it('defaults Retry-After to 1 second when missing on 429', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        status: 429,
        body: 'rate limited',
      }),
    );

    const provider = new OpenAITTSProvider({ apiKey: 'sk-test' });
    await expect(provider.synthesize(baseInput)).rejects.toMatchObject({
      retryAfterMs: 1000,
    });
  });

  it('throws TTSProviderError with status 500 on server error', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        status: 500,
        body: 'internal server error',
      }),
    );

    const provider = new OpenAITTSProvider({ apiKey: 'sk-test' });
    let caught: unknown;
    try {
      await provider.synthesize(baseInput);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TTSProviderError);
    const error = caught as TTSProviderError;
    expect(error.status).toBe(500);
    expect(error.bodyExcerpt).toContain('internal server error');
  });

  it('truncates bodyExcerpt to the first 500 characters', async () => {
    const longBody = 'x'.repeat(2000);
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        status: 400,
        body: longBody,
      }),
    );

    const provider = new OpenAITTSProvider({ apiKey: 'sk-test' });
    let caught: unknown;
    try {
      await provider.synthesize(baseInput);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TTSProviderError);
    const error = caught as TTSProviderError;
    expect(error.status).toBe(400);
    expect(error.bodyExcerpt.length).toBe(500);
    expect(error.bodyExcerpt).toBe('x'.repeat(500));
  });
});
