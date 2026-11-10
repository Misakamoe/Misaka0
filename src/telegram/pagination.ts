import { InlineKeyboard } from 'grammy';
import { AppError } from '../errors.js';

export interface PageBounds {
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  start: number;
  end: number;
}

export function pageBounds(total: number, page: number, pageSize: number): PageBounds {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(page) || page < 0
    || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new AppError('INVALID_INPUT');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(page, pages - 1);
  const start = page * pageSize;
  const end = start + Math.min(pageSize, total - start);
  return { page, pageSize, total, pages, start, end };
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageBounds & { items: T[] } {
  const bounds = pageBounds(items.length, page, pageSize);
  return { ...bounds, items: items.slice(bounds.start, bounds.end) };
}

function checkedCallback(data: string): string {
  if (typeof data !== 'string' || !data.length || Buffer.byteLength(data, 'utf8') > 64) throw new AppError('INVALID_INPUT');
  return data;
}

export function paginationKeyboard(
  bounds: PageBounds,
  callback: (page: number) => string,
  labels: { previous: string; next: string; page: (current: number, pages: number) => string },
  selectPage: string,
): InlineKeyboard {
  const { page, pages } = pageBounds(bounds.total, bounds.page, bounds.pageSize);
  const keyboard = new InlineKeyboard();
  if (pages === 1) return keyboard;
  const data = (target: number) => checkedCallback(callback(target));
  if (page === 0) keyboard.disabled(labels.previous);
  else keyboard.text(labels.previous, data(page - 1));
  keyboard.text(labels.page(page + 1, pages), checkedCallback(selectPage));
  if (page === pages - 1) keyboard.disabled(labels.next);
  else keyboard.text(labels.next, data(page + 1));
  return keyboard;
}

export function pageSelectionKeyboard(
  bounds: PageBounds,
  callbacks: { page: (page: number) => string; window: (window: number) => string; back: string },
  labels: { previous: string; next: string; back: string },
  requestedWindow?: number,
): InlineKeyboard {
  const { page, pages } = pageBounds(bounds.total, bounds.page, bounds.pageSize);
  const window = pageBounds(pages, requestedWindow ?? Math.floor(page / 20), 20);
  const keyboard = new InlineKeyboard();
  for (let target = window.start; target < window.end; target++) {
    if (target > window.start && (target - window.start) % 5 === 0) keyboard.row();
    keyboard.text(String(target + 1), checkedCallback(callbacks.page(target)));
    if (target === page) keyboard.primary();
  }
  if (window.pages > 1) {
    keyboard.row();
    if (window.page === 0) keyboard.disabled(labels.previous);
    else keyboard.text(labels.previous, checkedCallback(callbacks.window(window.page - 1)));
    if (window.page + 1 === window.pages) keyboard.disabled(labels.next);
    else keyboard.text(labels.next, checkedCallback(callbacks.window(window.page + 1)));
  }
  keyboard.row().text(labels.back, checkedCallback(callbacks.back));
  return keyboard;
}
