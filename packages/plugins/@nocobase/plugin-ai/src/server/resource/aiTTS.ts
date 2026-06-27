/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context, Next } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import { TTSAudioFormat, TTSProvider } from '@nocobase/ai';
import PluginAIServer from '../plugin';
import { computeTTSSourceHash, MessageTTSPipeline, TTSSseSink, TTSStorageWrite } from '../ai-employees/tts-manager';

interface ResolvedTTSConfig {
  serviceName: string;
  model: string;
  voice: string;
  speed: number;
}

interface SynthesizeBody {
  text?: string;
  serviceName?: string;
  model?: string;
  voice?: string;
  speed?: number;
  format?: TTSAudioFormat;
}

interface PreviewBody {
  serviceName?: string;
  model?: string;
  voice?: string;
  speed?: number;
}

interface ReplayBody {
  messageId?: string | number;
}

const PREVIEW_SAMPLES: Record<string, string> = {
  'zh-CN': '你好，这是一段语音试听示例。',
  'zh-TW': '你好，這是一段語音試聽範例。',
  'ja-JP': 'こんにちは。これは音声サンプルです。',
  'en-US': 'Hello! This is a voice preview sample.',
};

function pickPreviewSample(locale: string | undefined): string {
  if (locale && PREVIEW_SAMPLES[locale]) {
    return PREVIEW_SAMPLES[locale];
  }
  return PREVIEW_SAMPLES['en-US'];
}

async function resolveDefaultTTS(ctx: Context): Promise<ResolvedTTSConfig | null> {
  const settings = await ctx.db.getRepository('aiSettings').findOne();
  if (!settings) return null;
  const serviceName = settings.get?.('defaultTTSServiceName') ?? settings.defaultTTSServiceName ?? '';
  const model = settings.get?.('defaultTTSModel') ?? settings.defaultTTSModel ?? '';
  const voice = settings.get?.('defaultTTSVoice') ?? settings.defaultTTSVoice ?? '';
  const speed = settings.get?.('defaultTTSSpeed') ?? settings.defaultTTSSpeed ?? 1;
  if (!serviceName) return null;
  return { serviceName, model, voice, speed: Number(speed) || 1 };
}

function mergeTTSConfig(
  defaults: ResolvedTTSConfig | null,
  override: { serviceName?: string; model?: string; voice?: string; speed?: number },
): ResolvedTTSConfig | null {
  const base = defaults ?? { serviceName: '', model: '', voice: '', speed: 1 };
  const resolved: ResolvedTTSConfig = {
    serviceName: override.serviceName ?? base.serviceName,
    model: override.model ?? base.model,
    voice: override.voice ?? base.voice,
    speed: override.speed ?? base.speed,
  };
  if (!resolved.serviceName) return null;
  return resolved;
}

interface ResolvedTTSService {
  provider: TTSProvider;
  apiKey: string;
}

async function resolveTTSService(ctx: Context, serviceName: string): Promise<ResolvedTTSService | null> {
  const plugin = ctx.app.pm.get('ai') as PluginAIServer;
  const service = await ctx.db.getRepository('llmServices').findOne({
    filter: { name: serviceName },
  });
  if (!service) return null;
  const purpose = service.get?.('purpose') ?? service.purpose;
  if (purpose !== 'tts') return null;
  const opts = (service.get?.('options') ?? service.options) as { apiKey?: string; baseURL?: string } | undefined;
  if (!opts?.apiKey) return null;
  const provider = plugin.getTTSProviderForService(service);
  if (!provider) return null;
  return { provider, apiKey: opts.apiKey };
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

async function writeTTSAudio(ctx: Context, audio: Buffer, filename: string): Promise<{ id: number; url: string }> {
  const plugin = ctx.app.pm.get('ai') as PluginAIServer;
  const settings = await ctx.db.getRepository('aiSettings').findOne();
  const storageName = (settings?.get?.('options') ?? settings?.options)?.storage;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const tempPath = path.join(os.tmpdir(), `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}-${filename}`);
  await fs.writeFile(tempPath, audio);
  try {
    const record = await plugin.fileManager.createFileRecord({
      collectionName: 'aiFiles',
      filePath: tempPath,
      storageName,
      values: {
        kind: 'tts-audio',
        title: filename,
      },
    });
    return { id: record.get('id') as number, url: record.get('url') as string };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function synthesizeAction(ctx: Context, next: Next) {
  const body: SynthesizeBody = ctx.action.params.values ?? {};
  if (!body.text || typeof body.text !== 'string') {
    ctx.throw(400, ctx.t('text is required'));
  }
  const defaults = await resolveDefaultTTS(ctx);
  const resolved = mergeTTSConfig(defaults, body);
  if (!resolved) {
    ctx.throw(400, ctx.t('tts.defaultServiceMissing'));
    return;
  }
  const format: TTSAudioFormat = body.format ?? 'mp3';
  const service = await resolveTTSService(ctx, resolved.serviceName);
  if (!service) {
    ctx.throw(400, ctx.t('tts.unavailable'));
    return;
  }
  const sourceHash = computeTTSSourceHash({
    text: body.text,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format,
  });
  const cached = await ctx.db.getRepository('aiFiles').findOne({
    filter: { kind: 'tts-audio', sourceHash },
  });
  if (cached) {
    const url = (cached.get?.('url') ?? (cached as { url?: string }).url) as string | undefined;
    if (url) {
      ctx.body = { url, sourceHash };
      await next();
      return;
    }
  }

  const audioStream = await service.provider.synthesize({
    text: body.text,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format,
  });
  const audio = await readStreamToBuffer(audioStream);
  const written = await writeTTSAudio(ctx, audio, `tts-${Date.now()}.${format}`);
  await ctx.db.getRepository('aiFiles').update({
    filter: { id: written.id },
    values: { sourceHash, kind: 'tts-audio' },
  });
  ctx.body = { url: written.url, sourceHash };
  await next();
}

async function previewAction(ctx: Context, next: Next) {
  const body: PreviewBody = ctx.action.params.values ?? {};
  const defaults = await resolveDefaultTTS(ctx);
  const resolved = mergeTTSConfig(defaults, body);
  if (!resolved) {
    ctx.throw(400, ctx.t('tts.defaultServiceMissing'));
    return;
  }
  const service = await resolveTTSService(ctx, resolved.serviceName);
  if (!service) {
    ctx.throw(400, ctx.t('tts.unavailable'));
    return;
  }
  const text = pickPreviewSample(ctx.getCurrentLocale?.());
  const format: TTSAudioFormat = 'mp3';
  const sourceHash = computeTTSSourceHash({
    text,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format,
  });
  const cached = await ctx.db.getRepository('aiFiles').findOne({
    filter: { kind: 'tts-audio', sourceHash },
  });
  if (cached) {
    const url = (cached.get?.('url') ?? (cached as { url?: string }).url) as string | undefined;
    if (url) {
      ctx.body = { url };
      await next();
      return;
    }
  }
  const audioStream = await service.provider.synthesize({
    text,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format,
  });
  const audio = await readStreamToBuffer(audioStream);
  const written = await writeTTSAudio(ctx, audio, `tts-preview-${Date.now()}.${format}`);
  await ctx.db.getRepository('aiFiles').update({
    filter: { id: written.id },
    values: { sourceHash, kind: 'tts-audio' },
  });
  ctx.body = { url: written.url };
  await next();
}

/**
 * Core replay logic, decoupled from Koa context so it can be unit-tested with
 * stub repositories, sse sink, provider, and storageWrite.
 */
export interface RunReplayDeps {
  aiMessagesRepo: Pick<Repository, 'findOne'>;
  aiEmployeesRepo: Pick<Repository, 'findOne'>;
  usersAiEmployeesRepo: Pick<Repository, 'findOne'>;
  aiSettingsRepo: Pick<Repository, 'findOne'>;
  llmServicesRepo: Pick<Repository, 'findOne'>;
  aiFilesRepo: Repository;
  sse: TTSSseSink;
  storageWrite: TTSStorageWrite;
  getProvider: (serviceRow: {
    provider?: string;
    options?: { apiKey?: string; baseURL?: string };
  }) => TTSProvider | null;
  userId?: number;
}

export async function runReplay(messageId: string | number, deps: RunReplayDeps): Promise<void> {
  const message = await deps.aiMessagesRepo.findOne({ filter: { messageId } });
  if (!message) {
    deps.sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
    return;
  }
  const messageData = (message.toJSON?.() ?? message) as {
    messageId: string | number;
    sessionId?: string;
    role?: string;
    content?: { type?: string; content?: string } | null;
  };
  const text = messageData.content?.content;
  if (!text || typeof text !== 'string') {
    deps.sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
    return;
  }

  const employeeUsername = messageData.role;
  const employee = employeeUsername
    ? await deps.aiEmployeesRepo.findOne({ filter: { username: employeeUsername } })
    : null;
  const employeeData = employee
    ? ((employee.toJSON?.() ?? employee) as { voiceSettings?: Partial<ResolvedTTSConfig>; username?: string })
    : null;

  const userEmployee =
    deps.userId !== undefined && employeeData?.username
      ? await deps.usersAiEmployeesRepo.findOne({
          filter: { userId: deps.userId, aiEmployee: employeeData.username },
        })
      : null;
  const userEmployeeData = userEmployee
    ? ((userEmployee.toJSON?.() ?? userEmployee) as { voiceOverride?: Partial<ResolvedTTSConfig> })
    : null;

  const settings = await deps.aiSettingsRepo.findOne({});
  const settingsData = settings ? ((settings.toJSON?.() ?? settings) as Record<string, unknown>) : null;
  const defaults: ResolvedTTSConfig = {
    serviceName: String(settingsData?.defaultTTSServiceName ?? ''),
    model: String(settingsData?.defaultTTSModel ?? ''),
    voice: String(settingsData?.defaultTTSVoice ?? ''),
    speed: Number(settingsData?.defaultTTSSpeed ?? 1),
  };

  const resolved: ResolvedTTSConfig = {
    ...defaults,
    ...(employeeData?.voiceSettings ?? {}),
    ...(userEmployeeData?.voiceOverride ?? {}),
  } as ResolvedTTSConfig;
  if (!resolved.serviceName) {
    deps.sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
    return;
  }

  const service = await deps.llmServicesRepo.findOne({ filter: { name: resolved.serviceName } });
  if (!service) {
    deps.sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
    return;
  }
  const serviceData = (service.toJSON?.() ?? service) as {
    provider?: string;
    purpose?: string;
    options?: { apiKey?: string; baseURL?: string };
  };
  if (serviceData.purpose !== 'tts' || !serviceData.options?.apiKey) {
    deps.sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
    return;
  }
  const provider = deps.getProvider(serviceData);
  if (!provider) {
    deps.sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
    return;
  }

  const sourceMessageRowId = typeof messageData.messageId === 'number' ? messageData.messageId : undefined;
  const pipeline = new MessageTTSPipeline({
    provider,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format: 'mp3',
    messageId: String(messageData.messageId),
    sourceMessageRowId,
    sse: deps.sse,
    aiFilesRepo: deps.aiFilesRepo,
    storageWrite: deps.storageWrite,
  });
  // Feed the full text as a single token; the splitter will segment it.
  pipeline.pushToken(text);
  await pipeline.end();
}

function setupSSE(ctx: Context) {
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  ctx.status = 200;
}

async function replayAction(ctx: Context, next: Next) {
  const plugin = ctx.app.pm.get('ai') as PluginAIServer;
  const { messageId } = (ctx.action.params.values ?? ctx.action.params ?? {}) as ReplayBody;
  if (!messageId) {
    ctx.throw(400, ctx.t('messageId is required'));
    return;
  }
  setupSSE(ctx);

  const sse: TTSSseSink = {
    send: (event, data) => {
      ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };

  const storageWrite: TTSStorageWrite = async (stream, filename) => {
    const audio = await readStreamToBuffer(stream);
    return writeTTSAudio(ctx, audio, filename);
  };

  try {
    await runReplay(messageId, {
      aiMessagesRepo: ctx.db.getRepository('aiMessages'),
      aiEmployeesRepo: ctx.db.getRepository('aiEmployees'),
      usersAiEmployeesRepo: ctx.db.getRepository('usersAiEmployees'),
      aiSettingsRepo: ctx.db.getRepository('aiSettings'),
      llmServicesRepo: ctx.db.getRepository('llmServices'),
      aiFilesRepo: ctx.db.getRepository('aiFiles'),
      sse,
      storageWrite,
      getProvider: (serviceRow) => plugin.getTTSProviderForService(serviceRow),
      userId: ctx.auth?.user?.id,
    });
  } catch (err) {
    ctx.log?.error?.(err);
    sse.send('audio-chunk-failed', { messageId, seq: 0, range: [0, 0] });
  } finally {
    ctx.res.end();
    await next();
  }
}

export const aiTTS = {
  name: 'aiTTS',
  actions: {
    synthesize: synthesizeAction,
    preview: previewAction,
    replay: replayAction,
  },
};

export default aiTTS;
