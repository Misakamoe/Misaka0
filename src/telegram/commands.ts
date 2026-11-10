import type { BotCommand } from 'grammy/types';
import type { Locale } from '../../shared/schemas/index.js';
import { translator } from '../i18n.js';
import { modules } from '../modules/index.js';

export const commands = [
  { name: 'start', admin: false, private: false },
  { name: 'help', admin: false, private: false },
  { name: 'id', admin: false, private: false },
  { name: 'modules', admin: false, private: false },
  { name: 'commands', admin: false, private: false },
  { name: 'cancel', admin: false, private: false },
  { name: 'settings', admin: false, private: true },
  { name: 'stats', admin: true, private: true },
  { name: 'addgroup', admin: true, private: false },
  { name: 'listgroups', admin: true, private: true },
  { name: 'webui', admin: true, private: true },
  { name: 'alias', admin: true, private: true },
  { name: 'rss', admin: false, private: false },
  { name: 'rate', admin: false, private: false },
  { name: 'weather', admin: false, private: false },
  { name: 'forecast', admin: false, private: false },
  { name: 'sticker', admin: false, private: true },
  { name: 'subconv', admin: false, private: true },
] as const;

export function visibleCommands(admin: boolean, privateChat: boolean) {
  return commands.filter(command => (!command.admin || admin) && (!command.private || privateChat));
}

export function suggestCommands(name: string, admin: boolean, privateChat: boolean, aliasesFor: (command: string) => readonly string[]): string[] {
  const input = Array.from(name.normalize('NFKC').toLowerCase());
  if (input.length < 2 || input.length > 32) return [];
  const limit = input.length >= 6 ? 2 : 1;
  const matches: { name: string; distance: number }[] = [];
  for (const command of visibleCommands(admin, privateChat)) {
    let best = limit + 1;
    for (const candidate of [command.name, ...aliasesFor(command.name)]) {
      const target = Array.from(candidate);
      if (Math.abs(input.length - target.length) > limit) continue;
      const distance = Array.from({ length: input.length + 1 }, (_, row) =>
        Array.from({ length: target.length + 1 }, (_, column) => row === 0 ? column : column === 0 ? row : 0));
      for (let row = 1; row <= input.length; row++) {
        for (let column = 1; column <= target.length; column++) {
          distance[row]![column] = Math.min(distance[row - 1]![column]! + 1, distance[row]![column - 1]! + 1,
            distance[row - 1]![column - 1]! + (input[row - 1] === target[column - 1] ? 0 : 1));
          // Count adjacent swaps as one typo, including hlep -> help.
          if (row > 1 && column > 1 && input[row - 1] === target[column - 2] && input[row - 2] === target[column - 1]) {
            distance[row]![column] = Math.min(distance[row]![column]!, distance[row - 2]![column - 2]! + 1);
          }
        }
      }
      best = Math.min(best, distance[input.length]![target.length]!);
      if (best === 0) return [];
    }
    if (best <= limit) matches.push({ name: command.name, distance: best });
  }
  matches.sort((left, right) => left.distance - right.distance);
  return matches.filter(match => match.distance === matches[0]?.distance).slice(0, 3).map(match => match.name);
}

export function menuCommands(language: Locale, admin: boolean, privateChat: boolean): BotCommand[] {
  const t = translator(language);
  return visibleCommands(admin, privateChat).map(command => ({
    command: command.name, description: t(`bot:commands.${command.name}`),
  }));
}

export function menuLanguages(defaultLanguage: Locale): readonly (readonly ['' | 'en' | 'zh' | 'ja', Locale])[] {
  return [['', defaultLanguage], ['en', 'en'], ['zh', defaultLanguage === 'zh-TW' ? 'zh-TW' : 'zh-CN'], ['ja', 'ja']];
}

export function helpMarkdown(language: Locale, admin: boolean, privateChat: boolean): string {
  const t = translator(language);
  return [t('bot:help.intro'), t('bot:help.table'), t('bot:help.details', { count: modules.length }),
    ...(admin ? [t(privateChat ? 'bot:help.adminPrivate' : 'bot:help.adminGroup')] : []),
  ].join('\n\n');
}
