import { describe, expect, it } from 'vitest';
import { Bot, Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { SessionStore, messageTopicId, sessionKey } from '../src/telegram/session.js';

const me: UserFromGetMe = {
  id: 12345, is_bot: true, first_name: 'Test', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
  has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
const bot = new Bot('12345:offline-test', { botInfo: me });
function context(chatId = -100, userId = 7, thread?: number, botId = me.id): Context {
  const update: Update = { update_id: 1, message: {
    message_id: 1, date: 100, chat: { id: chatId, type: 'supergroup', title: 'Test' },
    from: { id: userId, is_bot: false, first_name: 'User' }, message_thread_id: thread, is_topic_message: thread !== undefined, text: '/settings',
  } };
  return new Context(update, bot.api, { ...me, id: botId });
}

describe('bounded on-demand Telegram sessions', () => {
  it('uses bot/chat/user/thread keys for messages and matching callback messages', () => {
    const ctx = context(-100, 7, 9);
    expect(sessionKey(ctx)).toBe('12345:-100:7:9');
    const callback = new Context({ update_id: 2, callback_query: {
      id: 'cb', from: ctx.from!, chat_instance: 'instance', message: ctx.message, data: 'mk:lang:en',
    } }, bot.api, me);
    expect(sessionKey(callback)).toBe(sessionKey(ctx));
    expect(new Set([
      sessionKey(ctx), sessionKey(context(-101, 7, 9)), sessionKey(context(-100, 8, 9)),
      sessionKey(context(-100, 7, 10)), sessionKey(context(-100, 7, undefined)), sessionKey(context(-100, 7, 9, 12346)),
    ]).size).toBe(6);
  });

  it('does not create state for reads and expires at the TTL boundary', () => {
    let now = 100;
    const sessions = new SessionStore(10, 2, () => now);
    expect(sessions.get('x')).toBeUndefined();
    expect(sessions.size).toBe(0);
    sessions.set('x', { rssInput: { panelId: 'panel', messageId: 4 } });
    now = 109;
    expect(sessions.get('x')).toEqual({ rssInput: { panelId: 'panel', messageId: 4 } });
    now = 110;
    expect(sessions.get('x')).toBeUndefined();
    expect(sessions.size).toBe(0);
  });
  it('ignores ordinary reply-thread IDs instead of treating them as topics', () => {
    const ctx = context(-100, 7, 1234);
    ctx.update.message!.is_topic_message = false;
    expect(messageTopicId(ctx.message!)).toBeUndefined();
    expect(sessionKey(ctx)).toBe('12345:-100:7:0');
    const callback = new Context({ update_id: 2, callback_query: {
      id: 'cb', from: ctx.from!, chat_instance: 'instance', message: { ...ctx.message!, message_thread_id: 5678 }, data: 'mk:ui:weather',
    } }, bot.api, me);
    expect(sessionKey(callback)).toBe(sessionKey(ctx));
  });
  it('retains topic isolation for forum groups and private bot topics', () => {
    const ctx = context(-100, 7, 9);
    expect(messageTopicId(ctx.message!)).toBe(9);
    ctx.update.message!.chat = { id: 7, type: 'private', first_name: 'User' };
    expect(sessionKey(ctx)).toBe('12345:7:7:9');
    ctx.update.message!.is_topic_message = false;
    expect(sessionKey(ctx)).toBe('12345:7:7:0');
  });

  it('bounds capacity, returns detached values, isolates cancel, and clears on stop', () => {
    const sessions = new SessionStore(100, 2, () => 0);
    sessions.set('a', { rssInput: { panelId: 'a', messageId: 1 } });
    sessions.set('b', { rssInput: { panelId: 'b', messageId: 2 } });
    sessions.set('c', { rssInput: { panelId: 'c', messageId: 3 } });
    expect(sessions.size).toBe(2);
    expect(sessions.get('a')).toBeUndefined();
    const detached = sessions.get('b')!;
    detached.rssInput!.messageId = 100;
    expect(sessions.get('b')?.rssInput?.messageId).toBe(2);
    sessions.delete('b');
    expect(sessions.get('c')?.rssInput?.messageId).toBe(3);
    sessions.stop();
    expect(sessions.size).toBe(0);
    expect(() => sessions.set('c', {})).toThrow('CANCELLED');
    expect(new SessionStore().size).toBe(0);
  });

  it('excludes edited, anonymous, bot, business, inaccessible and inline updates', () => {
    const base = context().message!;
    const updates = [
      { edited_message: base },
      { business_message: base },
      { message: { ...base, sender_chat: base.chat } },
      { message: { ...base, from: { ...base.from, is_bot: true } } },
      { message: { ...base, business_connection_id: 'business' } },
      { message: { ...base, guest_query_id: 'guest' } },
      { message: { ...base, chat: { id: -1, type: 'channel', title: 'Channel' } } },
      { callback_query: { id: 'cb', from: base.from, chat_instance: 'x', inline_message_id: 'x' } },
      { callback_query: { id: 'cb', from: base.from, chat_instance: 'x', message: { ...base, date: 0 } } },
    ];
    for (const update of updates) {
      expect(sessionKey(new Context({ update_id: 1, ...update } as Update, bot.api, me))).toBeUndefined();
    }
  });

  it('keeps detached subconv prompt bindings alongside other inputs without storing URL payloads', () => {
    let now = 0;
    const sessions = new SessionStore(100, 2, () => now);
    const key = sessionKey(context(7, 7, 9));
    const input = { panelId: 'panel', messageId: 10, promptMessageId: 11, field: 'source' as const, revision: 3, generation: 4 };
    const aliasInput = { panelId: 'alias', messageId: 12, command: 'help', revision: 0 };
    sessions.set(key, { subconvInput: input, aliasInput });
    input.promptMessageId = 99;
    const detached = sessions.get(key)!;
    expect(detached.subconvInput?.promptMessageId).toBe(11);
    detached.subconvInput!.revision = 8;
    expect(sessions.get(key)?.subconvInput?.revision).toBe(3);
    delete detached.subconvInput;
    sessions.set(key, detached);
    expect(sessions.get(key)).toEqual({ aliasInput });
    expect(sessions.get(sessionKey(context(7, 7, 10)))).toBeUndefined();
    now = 100;
    expect(sessions.get(key)).toBeUndefined();
  });
});
