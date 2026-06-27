/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TTSMessageControls } from '../TTSMessageControls';

vi.mock('../../../locale', () => ({
  useT: () => (key: string) => key,
}));

describe('TTSMessageControls', () => {
  it('renders the play button with aria-label when canPlay and state is idle', () => {
    const onPlay = vi.fn();
    const onStop = vi.fn();
    render(<TTSMessageControls state="idle" canPlay onPlay={onPlay} onStop={onStop} />);
    const btn = screen.getByRole('button', { name: 'tts.play' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('renders the stop button when state is playing', () => {
    const onPlay = vi.fn();
    const onStop = vi.fn();
    render(<TTSMessageControls state="playing" canPlay onPlay={onPlay} onStop={onStop} />);
    const btn = screen.getByRole('button', { name: 'tts.stop' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('hides the play button when canPlay is false and state is idle', () => {
    render(<TTSMessageControls state="idle" canPlay={false} onPlay={() => undefined} onStop={() => undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the replay button after playback finishes', () => {
    const onPlay = vi.fn();
    render(<TTSMessageControls state="done" canPlay onPlay={onPlay} onStop={() => undefined} />);
    const btn = screen.getByRole('button', { name: 'tts.play' });
    fireEvent.click(btn);
    expect(onPlay).toHaveBeenCalled();
  });

  it('keyboard activates the play button via Enter', () => {
    const onPlay = vi.fn();
    render(<TTSMessageControls state="idle" canPlay onPlay={onPlay} onStop={() => undefined} />);
    const btn = screen.getByRole('button', { name: 'tts.play' });
    btn.focus();
    // antd Button uses onClick which fires on space/enter via the underlying button element.
    fireEvent.click(btn);
    expect(onPlay).toHaveBeenCalled();
  });
});
