/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useT } from '../locale';
import { useLLMServiceCatalog } from '../llm-services/hooks/useLLMServiceCatalog';
import { AudioQueue } from '../../shared/tts/audioQueue';

const { Text } = Typography;

interface TTSSettingsValues {
  defaultTTSServiceName: string;
  defaultTTSModel: string;
  defaultTTSVoice: string;
  defaultTTSSpeed: number;
}

const DEFAULTS: TTSSettingsValues = {
  defaultTTSServiceName: '',
  defaultTTSModel: 'tts-1',
  defaultTTSVoice: 'alloy',
  defaultTTSSpeed: 1,
};

/**
 * Administrator-facing form for default TTS (text-to-speech) settings.
 * Persists to the aiSettings collection alongside other default fields.
 */
export const TTSSettings: React.FC = () => {
  const t = useT();
  const { message } = App.useApp();
  const api = useAPIClient();
  const [form] = Form.useForm<TTSSettingsValues>();
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const { services, loading: servicesLoading } = useLLMServiceCatalog();

  const { data, loading } = useRequest<TTSSettingsValues>(
    () =>
      api
        .resource('aiSettings')
        .get()
        .then((res) => res?.data?.data ?? {}),
    {
      onSuccess(values) {
        form.setFieldsValue({ ...DEFAULTS, ...(values ?? {}) });
      },
    },
  );

  const serviceOptions = useMemo(
    () => services.map((s) => ({ label: s.llmServiceTitle || s.llmService, value: s.llmService })),
    [services],
  );

  const onSave = useCallback(async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.resource('aiSettings').update({
        values,
        filterByTk: 1,
      });
      message.success(t('Saved successfully'));
    } catch (err) {
      message.error((err as Error)?.message || t('Request failed'));
    } finally {
      setSaving(false);
    }
  }, [api, form, message, t]);

  const onPreview = useCallback(async () => {
    const values = await form.validateFields();
    setPreviewing(true);
    try {
      const res = await api.resource('aiTTS').preview({
        values,
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
  }, [api, form, message, t]);

  useEffect(() => {
    if (data) {
      form.setFieldsValue({ ...DEFAULTS, ...data });
    }
  }, [data, form]);

  return (
    <Card loading={loading}>
      <Form<TTSSettingsValues> form={form} layout="vertical" initialValues={DEFAULTS} disabled={saving}>
        <Form.Item
          name="defaultTTSServiceName"
          label={t('Default TTS service')}
          help={<Text type="secondary">{t('Selects the LLM service used to synthesize voice replies.')}</Text>}
        >
          <Select allowClear loading={servicesLoading} options={serviceOptions} placeholder={t('Select a service')} />
        </Form.Item>
        <Form.Item name="defaultTTSModel" label={t('TTS model')}>
          <Input placeholder="tts-1" />
        </Form.Item>
        <Form.Item name="defaultTTSVoice" label={t('TTS voice')}>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="defaultTTSVoice" noStyle>
              <Input placeholder="alloy" />
            </Form.Item>
            <Button onClick={onPreview} loading={previewing} aria-label={t('tts.preview')}>
              {t('tts.preview')}
            </Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="defaultTTSSpeed" label={t('TTS speed')}>
          <InputNumber step={0.05} min={0.25} max={4} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" loading={saving} onClick={onSave}>
            {t('Save')}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};
