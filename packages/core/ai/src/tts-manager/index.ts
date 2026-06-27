/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { TTSProvider } from './types';

export * from './types';

export class TTSManager {
  private providers = new Map<string, TTSProvider>();

  registerProvider(name: string, provider: TTSProvider): void {
    this.providers.set(name, provider);
  }

  getProvider(name: string): TTSProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}
