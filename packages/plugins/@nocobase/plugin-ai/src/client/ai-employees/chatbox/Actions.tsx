/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo } from 'react';
import { usePlugin } from '@nocobase/client';
import { Button } from 'antd';
import { Schema } from '@formily/react';
import PluginAIClient from '../..';
import { useT } from '../../locale';
import { ActionOptions, ContextItem, Message } from '../types';
import { useChat } from './hooks/useChat';
import { useChatBoxStore } from './stores/chat-box';
import { useChatConversationsStore } from './stores/chat-conversations';
import { TTSMessageControls } from './TTSMessageControls';
import { useMessageTTS } from './hooks/useMessageTTS';
import { useTTSEnabled } from './hooks/useTTSEnabled';
import { getTTSBus } from './tts-bus';

export const Actions: React.FC<{
  message: Message & { messageId: string };
  responseType: string;
  value?: string;
}> = ({ responseType, message, value }) => {
  const t = useT();
  const plugin = usePlugin('ai') as PluginAIClient;
  const currentConversation = useChatConversationsStore.use.currentConversation();
  const chat = useChat(currentConversation);
  const responseLoading = chat.use.responseLoading();
  const messages = chat.use.messages();

  const currentEmployee = useChatBoxStore.use.currentEmployee();

  const lastEmployeeMessageKey = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === currentEmployee?.username) {
        return msg.key;
      }
    }
  }, [messages, currentEmployee?.username]);
  const workContext = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const workContext = messages[i].content.workContext;
      if (workContext?.length) {
        return workContext;
      }
    }
    return null;
  }, [messages]);
  const actions: (ActionOptions & { context: ContextItem })[] = useMemo(() => {
    if (!workContext?.length) {
      return [];
    }
    const result = [];
    for (const context of workContext) {
      const options = plugin.aiManager.getWorkContext(context.type);
      if (!options) {
        continue;
      }
      const actions = options.actions;
      if (!actions?.length) {
        continue;
      }
      for (const action of actions) {
        if (action.responseType && action.responseType !== responseType) {
          continue;
        }
        result.push({
          ...action,
          context,
        });
      }
    }
    return result;
  }, [plugin.aiManager, responseType, workContext]);

  // TTS controls: visible for the last assistant message in the conversation
  // (alongside any existing action buttons, or alone if no actions exist).
  const isLastEmployeeMessage = message.messageId === lastEmployeeMessageKey;
  const sseSource = useMemo(() => getTTSBus(currentConversation), [currentConversation]);
  const { enabled } = useTTSEnabled();
  const { state, stop, retry } = useMessageTTS({
    messageId: message.messageId,
    sseSource,
    enabled,
  });

  if (responseLoading) {
    return null;
  }

  if (!actions.length && !isLastEmployeeMessage) {
    return null;
  }

  const ttsControls = isLastEmployeeMessage ? (
    <TTSMessageControls state={state} onPlay={retry} onStop={stop} canPlay />
  ) : null;

  return (
    <div
      style={{
        marginTop: '8px',
      }}
    >
      {ttsControls}
      {actions.map((action, index) => {
        const C = action.Component;
        return C ? (
          <C item={action.context} message={message} value={value} />
        ) : (
          <Button
            size="small"
            key={index}
            icon={action.icon}
            onClick={() => action.onClick?.({ item: action.context, message, value })}
          >
            {Schema.compile(action.title, { t })}
          </Button>
        );
      })}
    </div>
  );
};
