/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import type { Model } from '@nocobase/database';
import type { TTSAudioFormat, TTSProvider } from '@nocobase/ai';
import type PluginAIServer from '../plugin';
import { MessageTTSPipeline, TTSSseSink, TTSStorageWrite } from './tts-manager';

interface ResolvedTTSConfig {
  serviceName: string;
  model: string;
  voice: string;
  speed: number;
}

interface ResolvedRuntime {
  provider: TTSProvider;
  config: ResolvedTTSConfig;
  storageWrite: TTSStorageWrite;
  aiFilesRepo: Repository;
}

/**
 * Resolve the effective TTS config for a streaming message and build the
 * runtime pieces (provider, storage writer) needed by MessageTTSPipeline. If
 * the resolved service is missing, has the wrong purpose, or has no apiKey,
 * returns null and the caller skips TTS entirely.
 */
export async function resolveTTSRuntime(opts: {
  ctx: Context;
  plugin: PluginAIServer;
  employee: Model;
  userId?: number;
}): Promise<ResolvedRuntime | null> {
  const { ctx, plugin, employee, userId } = opts;
  const settings = await ctx.db.getRepository('aiSettings').findOne();
  const settingsData = settings ? settings.toJSON?.() ?? settings : null;
  const defaults: ResolvedTTSConfig = {
    serviceName: String((settingsData as Record<string, unknown>)?.defaultTTSServiceName ?? ''),
    model: String((settingsData as Record<string, unknown>)?.defaultTTSModel ?? ''),
    voice: String((settingsData as Record<string, unknown>)?.defaultTTSVoice ?? ''),
    speed: Number((settingsData as Record<string, unknown>)?.defaultTTSSpeed ?? 1) || 1,
  };

  const voiceSettings = (employee.get?.('voiceSettings') ?? (employee as { voiceSettings?: unknown }).voiceSettings) as
    | Partial<ResolvedTTSConfig>
    | undefined;

  let voiceOverride: Partial<ResolvedTTSConfig> | undefined;
  if (userId !== undefined) {
    const username = (employee.get?.('username') ?? (employee as { username?: string }).username) as string | undefined;
    if (username) {
      const userEmployee = await ctx.db.getRepository('usersAiEmployees').findOne({
        filter: { userId, aiEmployee: username },
      });
      voiceOverride = userEmployee
        ? ((userEmployee.get?.('voiceOverride') ?? (userEmployee as { voiceOverride?: unknown }).voiceOverride) as
            | Partial<ResolvedTTSConfig>
            | undefined)
        : undefined;
    }
  }

  const merged: ResolvedTTSConfig = {
    ...defaults,
    ...(voiceSettings ?? {}),
    ...(voiceOverride ?? {}),
  } as ResolvedTTSConfig;
  if (!merged.serviceName) return null;

  const service = await ctx.db.getRepository('llmServices').findOne({ filter: { name: merged.serviceName } });
  if (!service) return null;
  const serviceData = (service.toJSON?.() ?? service) as {
    provider?: string;
    purpose?: string;
    options?: { apiKey?: string; baseURL?: string };
  };
  if (serviceData.purpose !== 'tts' || !serviceData.options?.apiKey) return null;
  const provider = plugin.getTTSProviderForService(serviceData);
  if (!provider) return null;

  const aiFilesRepo = ctx.db.getRepository('aiFiles');
  const storageWrite = makeStorageWrite(ctx, plugin);
  return { provider, config: merged, storageWrite, aiFilesRepo };
}

function makeStorageWrite(ctx: Context, plugin: PluginAIServer): TTSStorageWrite {
  return async (stream, filename) => {
    const settings = await ctx.db.getRepository('aiSettings').findOne();
    const storageName = ((settings?.get?.('options') ?? (settings as { options?: { storage?: string } })?.options)
      ?.storage ?? undefined) as string | undefined;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}-${filename}`);
    await fs.writeFile(tempPath, buf);
    try {
      const record = await plugin.fileManager.createFileRecord({
        collectionName: 'aiFiles',
        filePath: tempPath,
        storageName,
        values: { kind: 'tts-audio', title: filename },
      });
      return { id: record.get('id') as number, url: record.get('url') as string };
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  };
}

/**
 * Defers MessageTTSPipeline construction until a real aiMessages row id is
 * available. Tokens captured before then are buffered and replayed once the
 * pipeline materializes. If TTS is unavailable or never materializes, all
 * methods are safe no-ops so the LLM loop can call them unconditionally.
 */
export class StreamingTTSCoordinator {
  private pipeline: MessageTTSPipeline | null = null;
  private buffered: string[] = [];
  private canceled = false;
  private ended = false;

  constructor(
    private readonly runtime: ResolvedRuntime | null,
    private readonly sse: TTSSseSink,
    private readonly format: TTSAudioFormat = 'mp3',
  ) {}

  pushToken(token: string): void {
    if (!this.runtime || this.canceled || this.ended || !token) return;
    if (this.pipeline) {
      this.pipeline.pushToken(token);
    } else {
      this.buffered.push(token);
    }
  }

  /**
   * Called once the persisted aiMessages row id is known. Materializes the
   * pipeline, replays buffered tokens, and forwards subsequent ones.
   */
  noteMessageSaved(messageIdRaw: string | number): void {
    if (!this.runtime || this.canceled || this.ended || this.pipeline) return;
    const messageIdStr = String(messageIdRaw);
    const sourceMessageRowId = typeof messageIdRaw === 'number' ? messageIdRaw : Number(messageIdRaw);
    this.pipeline = new MessageTTSPipeline({
      provider: this.runtime.provider,
      model: this.runtime.config.model,
      voice: this.runtime.config.voice,
      speed: this.runtime.config.speed,
      format: this.format,
      messageId: messageIdStr,
      sourceMessageRowId: Number.isFinite(sourceMessageRowId) ? sourceMessageRowId : undefined,
      sse: this.sse,
      aiFilesRepo: this.runtime.aiFilesRepo,
      storageWrite: this.runtime.storageWrite,
    });
    for (const token of this.buffered) {
      this.pipeline.pushToken(token);
    }
    this.buffered = [];
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (!this.pipeline) return;
    try {
      await this.pipeline.end();
    } catch {
      // Pipeline does not throw out of end(); guard against future regressions.
    }
  }

  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    this.pipeline?.cancel();
  }
}

export function makeAudioChunkSink(ctx: Context): TTSSseSink {
  return {
    send: (event, data) => {
      const payload = `data: ${JSON.stringify({ type: event, body: data })}\n\n`;
      ctx.res.write(payload);
    },
  };
}
