import { describe, expect, it, vi } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { pageBounds, pageSelectionKeyboard, paginate, paginationKeyboard } from '../src/telegram/pagination.js';

const labels = { previous: '\u25c1 Prev', next: 'Next \u25b7', page: (current: number, pages: number) => `${current}/${pages}` };

describe('generic pagination bounds', () => {
  it.each([0, 1, 10, Number.MAX_SAFE_INTEGER])('normalizes empty lists at requested page %s', page => {
    expect(pageBounds(0, page, 5)).toEqual({ page: 0, pageSize: 5, total: 0, pages: 1, start: 0, end: 0 });
    expect(paginate([], page, 5).items).toEqual([]);
  });

  it.each([
    [1, 0, 5, 0, 1, 0, 1],
    [5, 1, 5, 0, 1, 0, 5],
    [6, 0, 5, 0, 2, 0, 5],
    [6, 1, 5, 1, 2, 5, 6],
    [10, 2, 5, 1, 2, 5, 10],
    [11, 1, 5, 1, 3, 5, 10],
    [11, 99, 5, 2, 3, 10, 11],
    [3, 99, 1, 2, 3, 2, 3],
  ])('calculates total=%s page=%s size=%s', (total, page, pageSize, expectedPage, pages, start, end) => {
    expect(pageBounds(total, page, pageSize)).toEqual({ page: expectedPage, pageSize, total, pages, start, end });
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid numeric input %s', invalid => {
    expect(() => pageBounds(invalid, 0, 5)).toThrow('INVALID_INPUT');
    expect(() => pageBounds(10, invalid, 5)).toThrow('INVALID_INPUT');
    expect(() => pageBounds(10, 0, invalid)).toThrow('INVALID_INPUT');
  });

  it('rejects zero page size', () => {
    expect(() => pageBounds(0, 0, 0)).toThrow('INVALID_INPUT');
    expect(() => paginate([], 0, 0)).toThrow('INVALID_INPUT');
  });

  it('keeps bounds safe at the integer limit without overflowing end', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(pageBounds(max, max, 1)).toEqual({ page: max - 1, pageSize: 1, total: max, pages: max, start: max - 1, end: max });
    expect(pageBounds(max, max, max - 1)).toEqual({ page: 1, pageSize: max - 1, total: max, pages: 2, start: max - 1, end: max });
    expect(pageBounds(max, max, max)).toEqual({ page: 0, pageSize: max, total: max, pages: 1, start: 0, end: max });
    for (const pageSize of [2, 3, 7, Math.floor(max / 2)]) {
      const bounds = pageBounds(max, max, pageSize);
      expect(bounds.end).toBe(max);
      expect(bounds.start).toBeLessThan(max);
      expect(Object.values(bounds).every(Number.isSafeInteger)).toBe(true);
    }
  });

  it('slices readonly arbitrary data without mutating or retaining the input array', () => {
    const items = Object.freeze([{ chatId: -1 }, { chatId: -2 }, { chatId: -3 }]);
    const result = paginate(items, 1, 2);
    expect(result).toEqual({ page: 1, pageSize: 2, total: 3, pages: 2, start: 2, end: 3, items: [{ chatId: -3 }] });
    expect(result.items).not.toBe(items);
    expect(result.items[0]).toBe(items[2]);
    result.items.pop();
    expect(items).toHaveLength(3);
    expect(paginate(['a', 'b', 'c'], 99, 2).items).toEqual(['c']);
  });
});

describe('localized native pagination keyboards', () => {
  it.each([0, 1, 5])('omits navigation for a single page containing %s items', total => {
    const callback = vi.fn(() => 'unused');
    const page = vi.fn(labels.page);
    const keyboard = paginationKeyboard(pageBounds(total, 99, 5), callback, { ...labels, page }, 'choose-page');
    expect(keyboard).toBeInstanceOf(InlineKeyboard);
    expect(keyboard.inline_keyboard.flat()).toEqual([]);
    expect(callback).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it('disables the first boundary and makes the compact page counter selectable', () => {
    const callback = vi.fn((page: number) => `mk:ui:${'a'.repeat(24)}:page:${page}`);
    const current = vi.fn(labels.page);
    const keyboard = paginationKeyboard(pageBounds(11, 0, 5), callback, { ...labels, page: current }, 'choose-page');
    expect(keyboard.inline_keyboard).toEqual([[
      InlineKeyboard.disabled(labels.previous), InlineKeyboard.text('1/3', 'choose-page'),
      InlineKeyboard.text(labels.next, `mk:ui:${'a'.repeat(24)}:page:1`),
    ]]);
    expect(current).toHaveBeenCalledExactlyOnceWith(1, 3);
    expect(callback).toHaveBeenCalledExactlyOnceWith(1);
    expect(keyboard.inline_keyboard[0]![0]).not.toHaveProperty('callback_data');
    expect(keyboard.inline_keyboard[0]![1]).toHaveProperty('callback_data', 'choose-page');
  });

  it('renders previous/current/next in one row for intermediate pages', () => {
    const callback = vi.fn((page: number) => `target:${page}`);
    const keyboard = paginationKeyboard(pageBounds(11, 1, 5), callback, labels, 'choose-page');
    expect(keyboard.inline_keyboard).toEqual([[
      InlineKeyboard.text(labels.previous, 'target:0'), InlineKeyboard.text('2/3', 'choose-page'), InlineKeyboard.text(labels.next, 'target:2'),
    ]]);
    expect(callback.mock.calls).toEqual([[0], [2]]);
  });

  it('clamps to the last page and disables its next button', () => {
    const callback = vi.fn((page: number) => `target:${page}`);
    const keyboard = paginationKeyboard(pageBounds(11, 999, 5), callback, labels, 'choose-page');
    expect(keyboard.inline_keyboard).toEqual([[
      InlineKeyboard.text(labels.previous, 'target:1'), InlineKeyboard.text('3/3', 'choose-page'), InlineKeyboard.disabled(labels.next),
    ]]);
    expect(callback).toHaveBeenCalledExactlyOnceWith(1);
    expect(keyboard.inline_keyboard[0]![2]).not.toHaveProperty('callback_data');
  });

  it('uses every label supplied by the caller without hardcoded user-facing strings', () => {
    const localized = { previous: '\u4e0a\u4e00\u9875', next: '\u4e0b\u4e00\u9875', page: (current: number, pages: number) => `\u7b2c${current}/${pages}\u9875` };
    const keyboard = paginationKeyboard(pageBounds(6, 0, 5), page => `page:${page}`, localized, 'choose-page');
    expect(keyboard.inline_keyboard[0]!.map(button => button.text)).toEqual([
      localized.previous, localized.page(1, 2), localized.next,
    ]);
  });

  it.each(['x', 'x'.repeat(64), '\u00e9'.repeat(32), '\u{1f600}'.repeat(16)])('accepts valid UTF-8 callback byte lengths', data => {
    const keyboard = paginationKeyboard(pageBounds(6, 0, 5), () => data, labels, data);
    expect(keyboard.inline_keyboard[0]![2]).toHaveProperty('callback_data', data);
    expect(keyboard.inline_keyboard[0]![1]).toHaveProperty('callback_data', data);
  });

  it.each(['', 'x'.repeat(65), '\u00e9'.repeat(33), '\u{1f600}'.repeat(17)])('rejects empty or oversized UTF-8 callbacks', data => {
    expect(() => paginationKeyboard(pageBounds(6, 0, 5), () => data, labels, 'choose-page')).toThrow('INVALID_INPUT');
    expect(() => paginationKeyboard(pageBounds(6, 1, 5), () => data, labels, 'choose-page')).toThrow('INVALID_INPUT');
    expect(() => paginationKeyboard(pageBounds(6, 1, 5), () => 'valid', labels, data)).toThrow('INVALID_INPUT');
  });

  it('validates both actionable directions, not only the first callback', () => {
    expect(() => paginationKeyboard(pageBounds(11, 1, 5), page => page === 0 ? 'valid' : 'x'.repeat(65), labels, 'choose-page'))
      .toThrow('INVALID_INPUT');
  });
});

describe('bounded reusable page selection', () => {
  const callbacks = { page: (page: number) => `page:${page}`, window: (window: number) => `pick:${window}`, back: 'return' };
  const pickerLabels = { ...labels, back: 'Back to list' };
  const numbers = (keyboard: InlineKeyboard) => keyboard.inline_keyboard.flat().filter(button => /^\d+$/.test(button.text));

  it('selects arbitrary pages, highlights the current page, and provides a way back', () => {
    const keyboard = pageSelectionKeyboard(pageBounds(13, 1, 5), callbacks, pickerLabels);
    expect(keyboard.inline_keyboard).toEqual([
      [InlineKeyboard.text('1', 'page:0'), { ...InlineKeyboard.text('2', 'page:1'), style: 'primary' }, InlineKeyboard.text('3', 'page:2')],
      [InlineKeyboard.text(pickerLabels.back, 'return')],
    ]);
  });

  it.each([[0, 1, 20], [1, 21, 40], [2, 41, 45], [999, 41, 45]])('bounds selector window %s to pages %s-%s', (window, first, last) => {
    const keyboard = pageSelectionKeyboard(pageBounds(450, 0, 10), callbacks, pickerLabels, window);
    const choices = numbers(keyboard);
    expect(choices.map(button => Number(button.text))).toEqual(Array.from({ length: last - first + 1 }, (_, index) => first + index));
    expect(choices.length).toBeLessThanOrEqual(20);
    expect(keyboard.inline_keyboard.every(row => row.length <= 5)).toBe(true);
    const navigation = keyboard.inline_keyboard.at(-2)!;
    expect(navigation.map(button => button.text)).toEqual([labels.previous, labels.next]);
    if (window === 0) expect(navigation[0]).not.toHaveProperty('callback_data');
    if (window >= 2) expect(navigation[1]).not.toHaveProperty('callback_data');
  });

  it('opens around the current page by default without allocating all pages', () => {
    const keyboard = pageSelectionKeyboard(pageBounds(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1), callbacks, pickerLabels);
    const choices = numbers(keyboard);
    expect(choices.length).toBeLessThanOrEqual(20);
    expect(choices.at(-1)).toMatchObject({ text: String(Number.MAX_SAFE_INTEGER), style: 'primary' });
    expect(keyboard.inline_keyboard.flat().length).toBeLessThanOrEqual(23);
  });

  it('handles empty/single-page results and validates selector inputs and every callback type', () => {
    const single = pageSelectionKeyboard(pageBounds(0, 0, 5), callbacks, pickerLabels);
    expect(numbers(single).map(button => button.text)).toEqual(['1']);
    for (const invalid of [-1, 0.5, NaN, Infinity]) expect(() => pageSelectionKeyboard(pageBounds(13, 0, 5), callbacks, pickerLabels, invalid)).toThrow('INVALID_INPUT');
    for (const invalid of ['', 'x'.repeat(65), '\u00e9'.repeat(33)]) {
      expect(() => pageSelectionKeyboard(pageBounds(13, 0, 5), { ...callbacks, page: () => invalid }, pickerLabels)).toThrow('INVALID_INPUT');
      expect(() => pageSelectionKeyboard(pageBounds(450, 0, 10), { ...callbacks, window: () => invalid }, pickerLabels)).toThrow('INVALID_INPUT');
      expect(() => pageSelectionKeyboard(pageBounds(13, 0, 5), { ...callbacks, back: invalid }, pickerLabels)).toThrow('INVALID_INPUT');
    }
  });
});
