import { describe, expect, it, vi } from 'vitest';
import { suggestCommands } from '../src/telegram/commands.js';

describe('command spelling suggestions', () => {
  it.each([
    ['hlep', 'help'], ['hepl', 'help'], ['hep', 'help'], ['helpp', 'help'], ['heop', 'help'],
    ['ＨＬＥＰ', 'help'], ['moduels', 'modules'], ['commnads', 'commands'], ['commad', 'commands'],
    ['setings', 'settings'], ['alais', 'alias'], ['addgrop', 'addgroup'], ['listgruops', 'listgroups'],
  ])('suggests %s -> %s for nearby spelling errors', (input, expected) => {
    expect(suggestCommands(input!, true, true, () => [])).toEqual([expected]);
  });

  it.each(['', 'h', 'x'.repeat(33), 'unrelatedword', 'hug', 'legacy_echo', 'help'])('does not guess for %s', input => {
    expect(suggestCommands(input, true, true, () => [])).toEqual([]);
  });

  it.each([
    ['助帮', '帮助'], ['助幫', '幫助'], ['ヘルブ', 'ヘルプ'], ['猫\u{10428}', '\u{10428}猫'],
  ])('matches Unicode alias %s by code points and suggests its canonical command', (input, alias) => {
    expect(suggestCommands(input!, false, true, command => command === 'help' ? [alias!] : [])).toEqual(['help']);
  });

  it('filters permissions before reading aliases', () => {
    const aliasesFor = vi.fn((command: string) => command === 'alias' ? ['secret'] : []);
    expect(suggestCommands('secrte', false, true, aliasesFor)).toEqual([]);
    expect(aliasesFor).not.toHaveBeenCalledWith('alias');
    expect(suggestCommands('secrte', true, true, aliasesFor)).toEqual(['alias']);
    expect(suggestCommands('setings', true, false, aliasesFor)).toEqual([]);
    expect(suggestCommands('listgruops', true, false, aliasesFor)).toEqual([]);
    expect(suggestCommands('addgrop', true, false, aliasesFor)).toEqual(['addgroup']);
    expect(suggestCommands('statss', false, true, aliasesFor)).toEqual([]);
  });

  it('returns at most three equally close canonical commands in stable registry order', () => {
    const aliases: Record<string, string[]> = { start: ['hat'], help: ['hot', 'hetz'], id: ['hit'], modules: ['hut'] };
    expect(suggestCommands('het', false, true, command => aliases[command] ?? [])).toEqual(['start', 'help', 'id']);
    expect(suggestCommands('helpzz', false, true, command => command === 'id' ? ['melpzz'] : [])).toEqual(['id']);
  });

  it('deduplicates alias matches and observes mapping changes without a stale cache', () => {
    const aliases: Record<string, string[]> = { help: ['guide', 'guids'] };
    const aliasesFor = (command: string) => aliases[command] ?? [];
    expect(suggestCommands('guidf', false, true, aliasesFor)).toEqual(['help']);
    expect(suggestCommands('guide', false, true, aliasesFor)).toEqual([]);
    aliases.help = [];
    expect(suggestCommands('guidf', false, true, aliasesFor)).toEqual([]);
  });
});
