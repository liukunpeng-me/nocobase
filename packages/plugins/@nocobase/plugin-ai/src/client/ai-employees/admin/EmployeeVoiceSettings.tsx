/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useState } from 'react';
import { App, Button, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import { useForm as useFormilyForm } from '@formily/react';
import { useAPIClient } from '@nocobase/client';
import { useT } from '../../locale';
import { useLLMServiceCatalog } from '../../llm-services/hooks/useLLMServiceCatalog';
import { AudioQueue } from '../../../shared/tts/audioQueue';

const { Text } = Typography;

interface VoiceSettingsValues {
  serviceName?: string;
  model?: string;
  voice?: string;
  speed?: number;
}

const SPEED_DEFAULT = 1;

/**
 * Form sub-panel for the AI Employee edit dialog. Binds to the employee row's
 * `voiceSettings` JSON column. An empty `serviceName` means "inherit the default
 * TTS service" — the help text explains this explicitly.
 */
export const EmployeeVoiceSettings: React.FC = () => {
  const t = useT();
  const { message } = App.useApp();
  const api = useAPIClient();
  const formilyForm = useFormilyForm();
  const initial = (formilyForm?.values?.voiceSettings ?? {}) as VoiceSettingsValues;

  const [values, setValues] = useState<VoiceSettingsValues>(initial);
  const [previewing, setPreviewing] = useState(false);

  const { services, loading: servicesLoading } = useLLMServiceCatalog();

  const update = useCallback(
    (patch: Partial<VoiceSettingsValues>) => {
      setValues((prev) => {
        const next = { ...prev, ...patch };
        if (formilyForm) {
          formilyForm.setValuesIn('voiceSettings', next);
        }
        return next;
      });
    },
    [formilyForm],
  );

  const onPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const res = await api.resource('aiTTS').preview({
        values: {
          serviceName: values.serviceName,
          model: values.model,
          voice: values.voice,
          speed: values.speed ?? SPEED_DEFAULT,
        },
      });
      const url = res?.data?.data?.url;
      if (!url) {
        message.warning(t('tts.unavailable'));
        return;
      }
      const queue = new AudioQueue();
      queue.enqueue({ seq: 0, url, range: [0, 0], messageId: 'preview' });
      await queue.start();
    } catch (err) {
      message.error((err as Error)?.message || t('tts.unavailable'));
    } finally {
      setPreviewing(false);
    }
  }, [api, message, t, values]);

  const serviceOptions = services.map((s) => ({
    label: s.llmServiceTitle || s.llmService,
    value: s.llmService,
  }));

  return (
    <Form layout="vertical">
      <Form.Item
        label={t('Voice service')}
        help={<Text type="secondary">{t('Leave empty to inherit the default TTS service.')}</Text>}
      >
        <Select
          allowClear
          loading={servicesLoading}
          options={serviceOptions}
          value={values.serviceName || undefined}
          onChange={(v) => update({ serviceName: v ?? '' })}
          placeholder={t('Inherit default')}
        />
      </Form.Item>
      <Form.Item label={t('TTS model')}>
        <Input value={values.model ?? ''} onChange={(e) => update({ model: e.target.value })} placeholder="tts-1" />
      </Form.Item>
      <Form.Item label={t('TTS voice')}>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={values.voice ?? ''} onChange={(e) => update({ voice: e.target.value })} placeholder="alloy" />
          <Button onClick={onPreview} loading={previewing} aria-label={t('tts.preview')}>
            {t('tts.preview')}
          </Button>
        </Space.Compact>
      </Form.Item>
      <Form.Item label={t('TTS speed')}>
        <InputNumber
          step={0.05}
          min={0.25}
          max={4}
          style={{ width: 160 }}
          value={values.speed ?? SPEED_DEFAULT}
          onChange={(v) => update({ speed: typeof v === 'number' ? v : SPEED_DEFAULT })}
        />
      </Form.Item>
    </Form>
  );
};
