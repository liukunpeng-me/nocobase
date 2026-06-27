/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { useChatBoxStore } from '../stores/chat-box';

const DISMISSED_STORAGE_KEY = 'ai-tts-prompt-dismissed';

export interface VoiceOverride {
  autoPlay?: boolean;
  serviceName?: string;
  model?: string;
  voice?: string;
  speed?: number;
}

export interface UseTTSEnabledResult {
  enabled: boolean;
  toggle: () => Promise<void>;
  promptVisible: boolean;
  acceptPrompt: () => Promise<void>;
  dismissPrompt: () => void;
}

const readDismissed = (): boolean => {
  try {
    return sessionStorage.getItem(DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const writeDismissed = (): void => {
  try {
    sessionStorage.setItem(DISMISSED_STORAGE_KEY, '1');
  } catch {
    // ignore — sessionStorage may be unavailable in some environments.
  }
};

const unlockAutoplayWithDummyAudio = async (): Promise<void> => {
  if (typeof Audio !== 'function') return;
  const audio = new Audio();
  audio.src = '';
  try {
    const ret = audio.play();
    if (ret && typeof ret.then === 'function') {
      await ret.catch(() => {
        // NotAllowedError swallowed — the gesture itself is what matters.
      });
    }
  } catch {
    // ignore — gesture is what unlocks future autoplay.
  }
};

export function useTTSEnabled(): UseTTSEnabledResult {
  const api = useAPIClient();
  const currentEmployee = useChatBoxStore.use.currentEmployee();
  const setCurrentEmployee = useChatBoxStore.use.setCurrentEmployee();

  const voiceOverride = useMemo<VoiceOverride>(
    () => (currentEmployee?.userConfig?.voiceOverride ?? {}) as VoiceOverride,
    [currentEmployee?.userConfig?.voiceOverride],
  );
  const initialEnabled = voiceOverride.autoPlay === true;

  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed());

  useEffect(() => {
    setEnabled(voiceOverride.autoPlay === true);
  }, [voiceOverride.autoPlay]);

  const persist = useCallback(
    async (next: boolean) => {
      if (!currentEmployee?.username) return;
      const nextOverride: VoiceOverride = { ...voiceOverride, autoPlay: next };
      await api.resource('aiEmployees').updateUserVoiceOverride({
        values: {
          aiEmployee: currentEmployee.username,
          voiceOverride: nextOverride,
        },
      });
      if (typeof setCurrentEmployee === 'function') {
        setCurrentEmployee((prev) => ({
          ...prev,
          userConfig: {
            ...prev?.userConfig,
            voiceOverride: nextOverride,
          },
        }));
      }
    },
    [api, currentEmployee, voiceOverride, setCurrentEmployee],
  );

  const toggle = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await persist(next);
    } catch {
      // Roll back on failure so UI matches server.
      setEnabled(!next);
    }
  }, [enabled, persist]);

  const acceptPrompt = useCallback(async () => {
    await unlockAutoplayWithDummyAudio();
    setEnabled(true);
    writeDismissed();
    setDismissed(true);
    try {
      await persist(true);
    } catch {
      setEnabled(false);
    }
  }, [persist]);

  const dismissPrompt = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  const promptVisible = !enabled && !dismissed && !!currentEmployee?.username;

  return { enabled, toggle, promptVisible, acceptPrompt, dismissPrompt };
}
