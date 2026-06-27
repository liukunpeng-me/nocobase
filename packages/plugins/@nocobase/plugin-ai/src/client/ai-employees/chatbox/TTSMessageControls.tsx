/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Button, Tooltip } from 'antd';
import { SoundOutlined, PauseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useT } from '../../locale';
import type { MessageTTSState } from './hooks/useMessageTTS';

export interface TTSMessageControlsProps {
  state: MessageTTSState;
  onPlay: () => void;
  onStop: () => void;
  canPlay: boolean;
}

/**
 * Render the per-message TTS Play / Stop / Replay button next to the
 * existing assistant-message actions. Visibility rules:
 *  - "Stop"   when state === 'playing'
 *  - "Replay" when state ∈ {done, stopped} AND canPlay
 *  - "Play"   otherwise when canPlay
 */
export const TTSMessageControls: React.FC<TTSMessageControlsProps> = ({ state, onPlay, onStop, canPlay }) => {
  const t = useT();

  if (state === 'playing') {
    const label = t('tts.stop');
    return (
      <Tooltip title={label}>
        <Button size="small" type="text" icon={<PauseCircleOutlined />} aria-label={label} onClick={onStop} />
      </Tooltip>
    );
  }

  if (!canPlay) {
    return null;
  }

  const isReplay = state === 'done' || state === 'stopped';
  const label = isReplay ? t('tts.play') : t('tts.play');
  return (
    <Tooltip title={label}>
      <Button
        size="small"
        type="text"
        icon={isReplay ? <ReloadOutlined /> : <SoundOutlined />}
        aria-label={label}
        onClick={onPlay}
      />
    </Tooltip>
  );
};
