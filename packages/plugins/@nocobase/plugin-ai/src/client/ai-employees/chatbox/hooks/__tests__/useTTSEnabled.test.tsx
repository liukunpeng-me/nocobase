/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@nocobase/client';
import { useTTSEnabled } from '../useTTSEnabled';

vi.mock('../../stores/chat-box', () => {
  const state = {
    currentEmployee: {
      username: 'alice',
      userConfig: { voiceOverride: undefined },
    },
  };
  const setCurrentEmployee = vi.fn();
  return {
    useChatBoxStore: Object.assign(() => state, {
      use: {
        currentEmployee: () => state.currentEmployee,
        setCurrentEmployee: () => setCurrentEmployee,
      },
    }),
  };
});

const setupApi = () => {
  const updateUserVoiceOverride = vi.fn().mockResolvedValue({ data: { data: { autoPlay: true } } });
  const apiClient = {
    resource: vi.fn((name: string) => {
      if (name === 'aiEmployees') return { updateUserVoiceOverride };
      throw new Error(`unexpected resource ${name}`);
    }),
  };
  vi.spyOn(client, 'useAPIClient').mockReturnValue(apiClient as never);
  return { apiClient, updateUserVoiceOverride };
};

describe('useTTSEnabled', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts disabled when no voiceOverride exists and shows the prompt', () => {
    setupApi();
    const { result } = renderHook(() => useTTSEnabled());
    expect(result.current.enabled).toBe(false);
    expect(result.current.promptVisible).toBe(true);
  });

  it('toggle persists to users-ai-employees.voiceOverride.autoPlay', async () => {
    const { updateUserVoiceOverride } = setupApi();
    const { result } = renderHook(() => useTTSEnabled());

    await act(async () => {
      await result.current.toggle();
    });

    expect(updateUserVoiceOverride).toHaveBeenCalledTimes(1);
    const call = updateUserVoiceOverride.mock.calls[0][0];
    expect(call.values.aiEmployee).toBe('alice');
    expect(call.values.voiceOverride.autoPlay).toBe(true);
  });

  it('acceptPrompt unlocks autoplay then persists and hides the prompt', async () => {
    const { updateUserVoiceOverride } = setupApi();
    const playSpy = vi.fn().mockResolvedValue(undefined);
    const originalAudio = (globalThis as { Audio?: typeof Audio }).Audio;
    (globalThis as unknown as { Audio: () => unknown }).Audio = function () {
      return { play: playSpy, src: '' };
    } as unknown as typeof Audio;

    try {
      const { result } = renderHook(() => useTTSEnabled());
      await act(async () => {
        await result.current.acceptPrompt();
      });

      expect(playSpy).toHaveBeenCalled();
      expect(updateUserVoiceOverride).toHaveBeenCalled();
      expect(result.current.promptVisible).toBe(false);
    } finally {
      if (originalAudio) {
        (globalThis as { Audio?: typeof Audio }).Audio = originalAudio;
      } else {
        delete (globalThis as { Audio?: typeof Audio }).Audio;
      }
    }
  });

  it('acceptPrompt swallows NotAllowedError from the dummy play and still persists', async () => {
    const { updateUserVoiceOverride } = setupApi();
    const blockedErr = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    const playSpy = vi.fn().mockRejectedValue(blockedErr);
    const originalAudio = (globalThis as { Audio?: typeof Audio }).Audio;
    (globalThis as unknown as { Audio: () => unknown }).Audio = function () {
      return { play: playSpy, src: '' };
    } as unknown as typeof Audio;

    try {
      const { result } = renderHook(() => useTTSEnabled());
      await act(async () => {
        await result.current.acceptPrompt();
      });
      expect(updateUserVoiceOverride).toHaveBeenCalled();
    } finally {
      if (originalAudio) {
        (globalThis as { Audio?: typeof Audio }).Audio = originalAudio;
      } else {
        delete (globalThis as { Audio?: typeof Audio }).Audio;
      }
    }
  });

  it('honours sessionStorage dismissal for the banner', () => {
    setupApi();
    sessionStorage.setItem('ai-tts-prompt-dismissed', '1');
    const { result } = renderHook(() => useTTSEnabled());
    expect(result.current.promptVisible).toBe(false);
  });
});
