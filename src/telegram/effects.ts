import { GrammyError, type Bot } from 'grammy';
import type { Locale } from '../../shared/schemas/index.js';
import type { ConfigurationService } from '../configuration.js';
import { AppError, throwIfAborted } from '../errors.js';
import { translator } from '../i18n.js';
import { menuCommands, menuLanguages } from './commands.js';

export interface ApiHealth { recordApiError(code: string): void }

// grammY's Node declarations still use the abort-controller shim. Its runtime
// accepts the native signal; keep the same object and cancellation lifetime.
export function telegramSignal(signal: AbortSignal): AbortSignal & NonNullable<Parameters<Bot['api']['getMe']>[0]> {
  return signal as AbortSignal & NonNullable<Parameters<Bot['api']['getMe']>[0]>;
}

export async function telegramCall<T>(health: ApiHealth, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await call();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AppError && error.code === 'CANCELLED'
      || error instanceof Error && error.name === 'AbortError') throw new AppError('CANCELLED');
    const code = error instanceof GrammyError ? `TELEGRAM_${error.error_code}` : 'TELEGRAM_UNAVAILABLE';
    health.recordApiError(code);
    throw new AppError(error instanceof GrammyError && error.error_code === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE');
  }
}

export async function bestEffort(call: () => Promise<unknown>): Promise<boolean> {
  try { await call(); return true; }
  catch (error) {
    if (error instanceof AppError && (error.code === 'CANCELLED' || error.code === 'TIMEOUT')) throw error;
    return false;
  }
}

export function plainValue(value: unknown, max = 128): string {
  return Array.from(String(value)).slice(0, max).map(character => {
    const point = character.codePointAt(0)!;
    return point < 32 || point === 127 ? ' ' : character;
  }).join('');
}

export function createTelegramEffects(bot: Bot, configuration: ConfigurationService, health: ApiHealth, adminIds: readonly number[] = []) {
  return {
    async describeGroup(chatId: number, signal: AbortSignal): Promise<{ title: string; present: boolean }> {
      if (!Number.isSafeInteger(chatId) || chatId >= 0) throw new AppError('INVALID_INPUT');
      const chat = await telegramCall(health, signal, () => bot.api.getChat(chatId, telegramSignal(signal)));
      if (chat.type !== 'group' && chat.type !== 'supergroup') throw new AppError('INVALID_INPUT');
      const member = await telegramCall(health, signal, () => bot.api.getChatMember(chatId, bot.botInfo.id, telegramSignal(signal)));
      const present = member.status === 'creator' || member.status === 'administrator' || member.status === 'member'
        || member.status === 'restricted' && member.is_member;
      return { title: plainValue(chat.title), present };
    },
    async notifyGroup(chatId: number, event: 'authorized' | 'revoked', language: Locale, signal: AbortSignal): Promise<boolean> {
      return bestEffort(() => telegramCall(health, signal, () => bot.api.sendMessage(
        chatId, translator(language)(`bot:groups.${event}`), {}, telegramSignal(signal),
      )));
    },
    async leaveGroup(chatId: number, signal: AbortSignal): Promise<boolean> {
      return bestEffort(() => telegramCall(health, signal, () => bot.api.leaveChat(chatId, telegramSignal(signal))));
    },
    async syncPrivateMenu(userId: number, language: Locale, signal: AbortSignal): Promise<boolean> {
      return bestEffort(async () => {
        const scope = { type: 'chat' as const, chat_id: userId };
        const admin = adminIds.includes(userId);
        const preference = configuration.getPreference(userId);
        for (const [languageCode, automaticLanguage] of menuLanguages(configuration.settings().effective.defaultLanguage)) {
          const resolved = preference.language === 'auto' ? automaticLanguage : language;
          await telegramCall(health, signal, () => bot.api.setMyCommands(menuCommands(resolved, admin, true), {
            scope, ...(languageCode ? { language_code: languageCode } : {}),
          }, telegramSignal(signal)));
        }
      });
    },
  };
}
