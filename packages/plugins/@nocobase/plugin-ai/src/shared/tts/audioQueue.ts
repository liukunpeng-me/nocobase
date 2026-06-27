/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface AudioChunk {
  seq: number;
  url: string;
  range: [number, number];
  messageId: string;
}

export type AudioQueueEvent =
  | { type: 'boundary'; chunk: AudioChunk }
  | { type: 'blocked' }
  | { type: 'error'; seq: number; cause: unknown }
  | { type: 'done' }
  | { type: 'stopped' };

export type AudioQueueListener = (ev: AudioQueueEvent) => void;

type AudioElementLike = Pick<HTMLAudioElement, 'play' | 'pause' | 'addEventListener' | 'removeEventListener'> & {
  src: string;
};

const defaultAudioFactory = (): HTMLAudioElement => {
  if (typeof Audio !== 'function') {
    throw new Error('AudioQueue: no HTMLAudioElement available; pass an audioFactory.');
  }
  return new Audio();
};

const isNotAllowedError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && name === 'NotAllowedError';
};

export class AudioQueue {
  private readonly audio: AudioElementLike;
  private readonly listeners = new Set<AudioQueueListener>();
  private readonly buffer = new Map<number, AudioChunk>();
  private readonly seenSeqs = new Set<number>();
  private nextSeq = 0;
  private playing = false;
  private busy = false;
  private blocked = false;
  private stopped = false;
  private runResolver: (() => void) | null = null;

  constructor(audioFactory: () => HTMLAudioElement = defaultAudioFactory) {
    this.audio = audioFactory();
  }

  enqueue(chunk: AudioChunk): void {
    if (this.stopped) return;
    if (this.seenSeqs.has(chunk.seq)) return;
    if (chunk.seq < this.nextSeq) return;
    this.seenSeqs.add(chunk.seq);
    this.buffer.set(chunk.seq, chunk);
    if (this.playing && !this.blocked && !this.busy && chunk.seq === this.nextSeq) {
      // We're inside a start() run that's idling on a gap; resume now that the gap is filled.
      this.advance();
    }
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.playing) {
      // A run is already in progress; wait for it to finish.
      return new Promise<void>((resolve) => {
        const prev = this.runResolver;
        this.runResolver = () => {
          prev?.();
          resolve();
        };
      });
    }
    this.blocked = false;
    this.playing = true;
    return new Promise<void>((resolve) => {
      this.runResolver = resolve;
      this.advance();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.audio.src = '';
    try {
      this.audio.pause();
    } catch {
      // ignore: stub or detached element
    }
    this.buffer.clear();
    this.emit({ type: 'stopped' });
    this.finishRun();
  }

  on(handler: AudioQueueListener): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private emit(ev: AudioQueueEvent): void {
    if (this.stopped && ev.type !== 'stopped') return;
    for (const listener of Array.from(this.listeners)) {
      listener(ev);
    }
  }

  private finishRun(): void {
    this.playing = false;
    this.busy = false;
    const resolver = this.runResolver;
    this.runResolver = null;
    resolver?.();
  }

  private advance(): void {
    if (this.stopped) {
      this.finishRun();
      return;
    }
    const chunk = this.buffer.get(this.nextSeq);
    if (!chunk) {
      // Nothing to play right now.
      if (this.buffer.size === 0) {
        this.emit({ type: 'done' });
        this.finishRun();
        return;
      }
      // A predecessor hasn't arrived yet; idle without ending the run. Future
      // enqueue() calls that fill the gap will resume playback.
      this.busy = false;
      return;
    }
    this.busy = true;
    this.playChunk(chunk);
  }

  private playChunk(chunk: AudioChunk): void {
    if (this.stopped) {
      this.finishRun();
      return;
    }

    this.emit({ type: 'boundary', chunk });
    if (this.stopped) {
      this.finishRun();
      return;
    }

    const onEnded = (): void => {
      this.audio.removeEventListener('ended', onEnded);
      if (this.stopped) {
        this.finishRun();
        return;
      }
      this.buffer.delete(chunk.seq);
      this.nextSeq = chunk.seq + 1;
      this.advance();
    };
    this.audio.addEventListener('ended', onEnded);

    this.audio.src = chunk.url;

    let playResult: Promise<void>;
    try {
      const ret = this.audio.play();
      playResult = ret instanceof Promise ? ret : Promise.resolve();
    } catch (err) {
      this.audio.removeEventListener('ended', onEnded);
      this.handlePlayFailure(chunk, err);
      return;
    }

    playResult.catch((err: unknown) => {
      this.audio.removeEventListener('ended', onEnded);
      this.handlePlayFailure(chunk, err);
    });
  }

  private handlePlayFailure(chunk: AudioChunk, cause: unknown): void {
    if (this.stopped) {
      this.finishRun();
      return;
    }
    if (isNotAllowedError(cause)) {
      this.blocked = true;
      try {
        this.audio.pause();
      } catch {
        // ignore
      }
      this.emit({ type: 'blocked' });
      this.finishRun();
      return;
    }
    this.emit({ type: 'error', seq: chunk.seq, cause });
    // Skip the failing chunk and continue.
    this.buffer.delete(chunk.seq);
    this.nextSeq = chunk.seq + 1;
    this.advance();
  }
}
