/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { TTSSynthesizeInput } from '@nocobase/ai';
import { BaseTTSProvider, BaseTTSProviderOptions } from './provider';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAITTSProvider extends BaseTTSProvider {
  constructor(opts: BaseTTSProviderOptions) {
    super(opts);
  }

  getDefaultBaseURL(): string {
    return DEFAULT_BASE_URL;
  }

  protected getRequestPath(): string {
    return 'audio/speech';
  }

  protected buildBody(input: TTSSynthesizeInput): Record<string, unknown> {
    return {
      model: input.model,
      voice: input.voice,
      input: input.text,
      response_format: input.format,
      speed: input.speed,
    };
  }
}
