/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiSettings',
  dataCategory: 'system',
  migrationRules: ['overwrite', 'schema-only'],
  fields: [
    {
      type: 'jsonb',
      name: 'options',
      defaultValue: {
        storage: 'local',
      },
    },
    {
      type: 'string',
      name: 'defaultLLMService',
    },
    {
      type: 'string',
      name: 'defaultModel',
    },
    {
      type: 'string',
      name: 'defaultTTSServiceName',
      defaultValue: '',
    },
    {
      type: 'string',
      name: 'defaultTTSModel',
      defaultValue: 'tts-1',
    },
    {
      type: 'string',
      name: 'defaultTTSVoice',
      defaultValue: 'alloy',
    },
    {
      type: 'double',
      name: 'defaultTTSSpeed',
      defaultValue: 1,
    },
  ],
});
