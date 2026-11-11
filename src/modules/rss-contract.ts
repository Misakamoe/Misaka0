import { normalizePublicUrl } from '../network.js';
import type { FeedContentFormat } from './rss-format.js';

export { NetworkError as FeedFetchError, normalizePublicUrl as normalizeFeedUrl } from '../network.js';
export interface FeedLink { offset: number; length: number; url: string }
export interface FeedEntry {
  id: string; title: string; url?: string; content: string; contentLinks?: FeedLink[]; publishedAt?: string; images?: string[]; image?: string;
  animationIndices?: number[]; imagePositions?: { offset: number; imageIndex: number }[];
  contentFormat?: FeedContentFormat;
}
export interface ParsedFeed { title: string; entries: FeedEntry[] }
export interface FeedValidators { etag?: string; lastModified?: string }
export interface FeedResponse extends FeedValidators { notModified: boolean; feed?: ParsedFeed; finalUrl: string }
export type FeedFetcher = (url: string, validators: FeedValidators, signal: AbortSignal) => Promise<FeedResponse>;
export type RssPhotoFetcher = (url: string, callerSignal: AbortSignal, maxBytes?: number) => Promise<Buffer>;
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const RSS_PHOTO_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const FEED_MAX_LINKS = 64;
export const FEED_MAX_IMAGES = 1000;
export const FEED_MAX_IMAGE_BYTES = 1024 * 1024;
export const FEED_MAX_IMAGE_POSITIONS = 1000;

export function contentLinkUrl(input: string, baseUrl?: string): string | undefined {
  try {
    if (input.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(input)) return;
    const url = new URL(input, baseUrl);
    normalizePublicUrl(url.href);
    // Article anchors matter to readers; only feed retrieval URLs discard fragments.
    return url.href;
  } catch { return; }
}

export function isGifImageUrl(input: string): boolean {
  try {
    const safe = contentLinkUrl(input);
    if (safe === undefined) return false;
    const pathname = new URL(safe).pathname;
    return /\.gif$/i.test(pathname) || /\.gif$/i.test(decodeURIComponent(pathname));
  } catch { return false; }
}
