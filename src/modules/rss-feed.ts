import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Parser } from 'htmlparser2';
import { LinkifyIt } from 'linkify-it';
import tlds from 'tlds' with { type: 'json' };
import { NetworkError as FeedFetchError, normalizePublicUrl as normalizeFeedUrl, publicAddress, resolveFeedAddresses,
  abortable, readBody, networkGet as transport, type NetworkTransport as FeedTransport, type NetworkResponse as FeedTransportResponse } from '../network.js';
export { NetworkError as FeedFetchError, normalizePublicUrl as normalizeFeedUrl, publicAddress, resolveFeedAddresses, resolvePublicAddresses } from '../network.js';
export type { NetworkTransport as FeedTransport, NetworkResponse as FeedTransportResponse, NetworkRequestOptions as FeedRequestOptions } from '../network.js';
import { FeedContentParseError, parseFormattedContent } from './rss-content.js';
import { contentLinkUrl, isGifImageUrl, FEED_MAX_BYTES, RSS_PHOTO_MAX_SOURCE_BYTES, FEED_MAX_LINKS, FEED_MAX_IMAGES,
  FEED_MAX_IMAGE_BYTES, FEED_MAX_IMAGE_POSITIONS, type FeedLink, type FeedEntry, type ParsedFeed, type FeedFetcher, type RssPhotoFetcher } from './rss-contract.js';
export { contentLinkUrl, isGifImageUrl, FEED_MAX_BYTES, RSS_PHOTO_MAX_SOURCE_BYTES, FEED_MAX_LINKS, FEED_MAX_IMAGES,
  FEED_MAX_IMAGE_BYTES, FEED_MAX_IMAGE_POSITIONS } from './rss-contract.js';
export type { FeedLink, FeedEntry, ParsedFeed, FeedValidators, FeedResponse, FeedFetcher, RssPhotoFetcher } from './rss-contract.js';
const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: false, urlAuth: true, maxLength: 2048, tlds, '---': true });
function isGifMime(type: string | undefined): boolean { return type?.split(';', 1)[0]?.trim().toLowerCase() === 'image/gif'; }
export function findFeedLinks(content: string, anchors: readonly { offset: number; length: number; url?: string }[] = []): FeedLink[] {
  const links: FeedLink[] = anchors.filter((span): span is FeedLink => span.url !== undefined).slice(0, FEED_MAX_LINKS);
  // Preserve UTF-16 offsets while separating prose from URLs. Keep international Latin domains intact.
  const masked = content.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\p{Emoji_Presentation}\u3000-\u303f\uff00-\uffef]/gu, character => ' '.repeat(character.length));
  const uriTokens = [...content.matchAll(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"`\u2018-\u201f\u3000-\u303f\uff00-\uffef]+/gi)];
  for (const match of linkify.match(masked) ?? []) {
    if (links.length >= FEED_MAX_LINKS) break;
    const after = content.slice(match.lastIndex);
    if (!['http:', 'https:', '', '//'].includes(match.schema)
      || anchors.some(span => match.index < span.offset + span.length && match.lastIndex > span.offset)
      // Never turn a suffix of an unsupported authority, or a prematurely stopped match, into another destination.
      || uriTokens.some(token => match.index > token.index && match.index < token.index + token[0].length)
      || match.schema === '' && /[a-z\d._%@/\\-]/i.test(content.charAt(match.index - 1))
      || !after.startsWith('---') && /^[a-z\d%_@+\-=/#&:\\]/i.test(after) || /^\.[a-z\d-]/i.test(after)) continue;
    const url = contentLinkUrl(match.schema === '' || match.schema === '//' ? match.url.replace(/^http:/, 'https:') : match.url);
    if (url) links.push({ offset: match.index, length: match.lastIndex - match.index, url });
  }
  return links.sort((left, right) => left.offset - right.offset);
}
function truncate(text: string, length: number): string { return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, ''); }
function htmlContent(html: string, length: number, baseUrl?: string, onImage?: (source: string, offset: number | undefined, gif: boolean, originalImage: boolean) => void): { content: string; contentLinks: FeedLink[] } {
  let content = ''; let whitespace = ''; let ignored = 0; let depth = 0; let tags = 0; let full = false;
  const anchors: { offset: number; length: number; url?: string }[] = [];
  let anchor: { url?: string; span?: (typeof anchors)[number] } | undefined;
  const append = (input: string) => {
    const clean = input.replace(/\p{Cc}/gu, character => character === '\n' || character === '\t' ? character : '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
    for (const [part] of clean.matchAll(/[ \t]+|\n|[^ \t\n]+/g)) {
      if (full) return;
      if (content.length >= length) { if (part.trim()) full = true; continue; }
      if (part === '\n') { whitespace = '\n'.repeat(Math.min(2, (whitespace.startsWith('\n') ? whitespace.length : 0) + 1)); continue; }
      if (/^[ \t]+$/.test(part)) { whitespace ||= ' '; continue; }
      const gap = content ? whitespace : '';
      const token = content ? part : part.trimStart();
      if (!token) continue;
      const word = truncate(token, Math.max(0, length - content.length - gap.length));
      full = word.length < token.length;
      if (!word) return;
      const offset = content.length + gap.length;
      content += gap + word; whitespace = '';
      if (anchor) {
        if (!anchor.span) { anchor.span = { offset, length: 0, ...(anchor.url ? { url: anchor.url } : {}) }; anchors.push(anchor.span); }
        anchor.span.length = content.length - anchor.span.offset;
      }
    }
  };
  const parser = new Parser({
    onopentag(name, attributes) {
      name = name.split(':').at(-1)!;
      if (++tags > 20_000 || ++depth > 48) throw new FeedFetchError('INVALID_FEED');
      if (['script', 'style', 'iframe', 'object', 'noscript', 'template'].includes(name)) ignored += 1;
      if (ignored) return;
      if (attributes.src && onImage) {
        const gif = isGifMime(attributes.type) || isGifImageUrl(contentLinkUrl(attributes.src, baseUrl) ?? '');
        // Offsets precede pending whitespace; collecting media must never alter text or anchor spans.
        if (name === 'img' || gif && (name === 'video' || name === 'source')) onImage(attributes.src, full ? undefined : content.length, gif, name === 'img');
      }
      if (name === 'a') anchor = { url: baseUrl !== undefined && attributes.href !== undefined ? contentLinkUrl(attributes.href, baseUrl) : undefined };
      if (['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'tr', 'blockquote'].includes(name)) append('\n');
    },
    onclosetag(name) {
      name = name.split(':').at(-1)!;
      depth = Math.max(0, depth - 1);
      if (['script', 'style', 'iframe', 'object', 'noscript', 'template'].includes(name)) ignored = Math.max(0, ignored - 1);
      if (ignored) return;
      if (name === 'a') anchor = undefined;
      if (['p', 'div', 'li', 'tr', 'blockquote'].includes(name)) append('\n');
    },
    ontext(text) { if (!ignored) append(text); },
  }, { decodeEntities: true, recognizeCDATA: true, recognizeSelfClosing: true });
  parser.end(html);
  content = content.trimEnd();
  const spans = anchors.map(span => ({ ...span, length: Math.min(span.length, content.length - span.offset) })).filter(span => span.length > 0);
  return { content, contentLinks: baseUrl === undefined ? [] : findFeedLinks(content, spans) };
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('\n');
  return Object.entries(object(value)).filter(([key]) => !key.startsWith('@_') && !['script', 'style', 'iframe', 'object', 'template'].includes(key)).map(([, child]) => text(child)).join('\n');
}
export function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  if (Buffer.byteLength(xml) > FEED_MAX_BYTES) throw new FeedFetchError('TOO_LARGE');
  const head = xml.trimStart().replace(/^<\?xml[^>]*>\s*/i, '').replace(/<!--[^]*?-->\s*/g, '');
  if (/^(?:<!doctype\s+html[^>]*>\s*)?<(?:html|head|body)[\s>]/i.test(head)) throw new FeedFetchError(/verif|captcha|challenge|cloudflare|access.denied/i.test(xml) ? 'BLOCKED' : 'INVALID_FEED');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) throw new FeedFetchError('INVALID_FEED');
  try {
    if (XMLValidator.validate(xml) !== true) throw new Error();
    let tags = 0;
    const parsed = object(new XMLParser({
      ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false,
      // Atom XHTML wraps its body in div; retain mixed text/link order until the HTML sanitizer.
      stopNodes: ['*.div'],
      maxNestedTags: 48, processEntities: { enabled: true, maxExpansionDepth: 4, maxEntityCount: 64, maxTotalExpansions: 10_000, maxExpandedLength: FEED_MAX_BYTES },
      updateTag(name) { if (++tags > 20_000) throw new Error(); return name; },
    }).parse(xml));
    const rss = object(parsed.rss);
    const rdf = object(parsed.RDF);
    const root = object(rss.channel ?? parsed.feed ?? rdf.channel);
    if (!Object.keys(root).length || !(rss.channel || parsed.feed || rdf.channel)) throw new Error();
    const items = array(root.item ?? root.entry ?? rdf.item).slice(0, 200);
    const entries: FeedEntry[] = [];
    const seen = new Set<string>();
    for (const value of items) {
      const item = object(value);
      const title = htmlContent(text(item.title), 256).content;
      const bodies = [item.encoded, item.content, item.description, item.summary].map(text);
      const rawContent = bodies.find(value => value.trim()) ?? '';
      const links = array(item.link);
      const alternate = links.find(link => object(link)['@_href'] && (!object(link)['@_rel'] || object(link)['@_rel'] === 'alternate'));
      const link = text(object(alternate)['@_href']) || text(links.find(link => typeof link === 'string'));
      let url: string | undefined;
      try { if (link) url = normalizeFeedUrl(new URL(link, baseUrl).href); } catch { /* Ignore unsafe article links without fetching them. */ }
      const images: string[] = []; const imageIndices = new Map<string, number>(); let imageBytes = 2;
      const animations = new Set<number>();
      const identityImages = new Set<string>();
      const positions: NonNullable<FeedEntry['imagePositions']> = [];
      const addImage = (candidate: string, imageBase = baseUrl, gif = false, originalImage = true) => {
        if (!candidate) return;
        const safe = contentLinkUrl(candidate, imageBase);
        if (!safe) return;
        const image = normalizeFeedUrl(safe);
        let index = imageIndices.get(image);
        if (index === undefined) {
          imageBytes += Buffer.byteLength(JSON.stringify(image)) + (images.length ? 1 : 0);
          if (images.length >= FEED_MAX_IMAGES || imageBytes > FEED_MAX_IMAGE_BYTES) throw new FeedFetchError('TOO_LARGE');
          index = images.length; imageIndices.set(image, index); images.push(image);
        }
        if (gif || isGifImageUrl(image)) animations.add(index);
        if (originalImage) identityImages.add(image);
        return index;
      };
      const collectMedia = (container: Record<string, unknown>) => {
        // Keep the existing metadata priority, then descend into content and group containers.
        for (const key of ['thumbnail', 'content', 'enclosure', 'link', 'group']) {
          for (const child of array(container[key]).map(object)) {
            const candidate = text(child['@_url'] ?? child['@_href'] ?? child['@_src']);
            if (key === 'thumbnail' || child['@_medium'] === 'image' || String(child['@_type'] ?? '').toLowerCase().startsWith('image/')) {
              addImage(candidate, baseUrl, isGifMime(text(child['@_type'])));
            } else if (candidate) {
              const safe = contentLinkUrl(candidate, baseUrl);
              if (safe && isGifImageUrl(safe)) addImage(safe, baseUrl, true, false);
            }
            if (key === 'content' || key === 'group') collectMedia(child);
          }
        }
      };
      collectMedia(item);
      const bodyImage = (source: string, _offset: number | undefined, gif: boolean, originalImage: boolean) => addImage(source, url ?? baseUrl, gif, originalImage);
      const legacy = htmlContent(rawContent, 12_000, url ?? baseUrl, (source, offset, gif, originalImage) => {
        const imageIndex = bodyImage(source, offset, gif, originalImage);
        if (imageIndex === undefined || offset === undefined) return;
        if (positions.length >= FEED_MAX_IMAGE_POSITIONS) throw new FeedFetchError('TOO_LARGE');
        positions.push({ offset, imageIndex });
      });
      const legacyPositions = positions.map(position => ({ ...position, offset: Math.min(position.offset, legacy.content.length) }))
        .filter(({ offset }) => !(/[\uD800-\uDBFF]/.test(legacy.content.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(legacy.content.charAt(offset))));
      // Alternate descriptions can contain additional images, but must not change the chosen text or its links.
      for (const body of new Set(bodies)) if (body !== rawContent && body.trim()) htmlContent(body, 0, url ?? baseUrl, bodyImage);
      const formatted = parseFormattedContent(rawContent, {
        limit: 12_000, resolveLink: value => contentLinkUrl(value, url ?? baseUrl), findLinks: findFeedLinks,
        image: (source, gif, originalImage) => bodyImage(source, undefined, gif, originalImage),
        isGif: (source, mime) => isGifMime(mime) || isGifImageUrl(contentLinkUrl(source, url ?? baseUrl) ?? ''),
      });
      const { content, contentLinks } = formatted ?? legacy;
      const imagePositions = formatted?.imagePositions ?? legacyPositions;
      const identity = text(item.guid ?? item.id) || url;
      if (!title && !legacy.content && !identity && !images.length) continue;
      // Formatting must not change legacy 12k text hashes or the original-image-only fallback.
      const rawId = identity || (title || legacy.content ? `${title}\n${legacy.content}` : JSON.stringify(identityImages.size ? [...identityImages] : images));
      const id = createHash('sha256').update(rawId).digest('hex');
      if (seen.has(id)) continue;
      seen.add(id);
      const date = Date.parse(text(item.pubDate ?? item.published ?? item.updated ?? item.date));
      entries.push({ id, title, content, contentLinks, ...(url ? { url } : {}),
        ...(formatted ? { contentFormat: formatted.contentFormat } : {}),
        ...(images.length ? { images, animationIndices: [...animations].sort((left, right) => left - right), imagePositions } : {}),
        ...(Number.isFinite(date) && date >= 0 && date < 253402300800000 ? { publishedAt: new Date(date).toISOString() } : {}) });
    }
    return { title: htmlContent(text(root.title), 128).content || new URL(baseUrl).hostname, entries };
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(error instanceof FeedContentParseError ? error.code : 'INVALID_FEED');
  }
}

export function createFeedFetcher(options: {
  lookup?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>; transport?: FeedTransport; timeoutMs?: number;
} = {}): FeedFetcher {
  return async (input, validators, callerSignal) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = AbortSignal.any([callerSignal, timeout]);
    let url = new URL(normalizeFeedUrl(input));
    const originalOrigin = url.origin;
    try {
      for (let redirect = 0; redirect <= 4; redirect++) {
        signal.throwIfAborted();
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable((options.lookup ?? resolveFeedAddresses)(host, signal), signal);
        if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new FeedFetchError('UNSAFE_URL');
        const headers: Record<string, string> = {
          'user-agent': 'MisakaRSS/0.1',
          accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
        };
        if (url.origin === originalOrigin) {
          if (validators.etag && validators.etag.length <= 1024 && !/[\r\n]/.test(validators.etag)) headers['if-none-match'] = validators.etag;
          if (validators.lastModified && validators.lastModified.length <= 256 && !/[\r\n]/.test(validators.lastModified)) headers['if-modified-since'] = validators.lastModified;
        }
        const response = await (options.transport ?? transport)(url, { addresses, headers, signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          response.body.destroy();
          if (!response.headers.location || redirect === 4) throw new FeedFetchError('HTTP_ERROR', response.status);
          url = new URL(normalizeFeedUrl(new URL(response.headers.location, url).href));
          continue;
        }
        const etag = typeof response.headers.etag === 'string' && response.headers.etag.length <= 1024 ? response.headers.etag : undefined;
        const lastModified = typeof response.headers['last-modified'] === 'string' && response.headers['last-modified'].length <= 256 ? response.headers['last-modified'] : undefined;
        if (response.status === 304) { response.body.destroy(); return { notModified: true, etag, lastModified, finalUrl: url.href }; }
        if (response.status !== 200) {
          response.body.destroy();
          const retry = response.headers['retry-after'];
          const duration = typeof retry === 'string' ? /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0;
          throw new FeedFetchError(response.status === 401 || response.status === 403 ? 'BLOCKED' : 'HTTP_ERROR', response.status,
            Number.isFinite(duration) && duration > 0 ? Math.min(duration, 86_400_000) : undefined);
        }
        if (Number(response.headers['content-length']) > FEED_MAX_BYTES) { response.body.destroy(); throw new FeedFetchError('TOO_LARGE'); }
        const buffer = await readBody(response, signal);
        const contentType = String(response.headers['content-type'] ?? '');
        const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
          ?? /<\?xml[^>]+encoding\s*=\s*["']([^"']+)/i.exec(buffer.subarray(0, 256).toString('ascii'))?.[1];
        const charset = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : declared ?? 'utf-8';
        let xml: string;
        try { xml = new TextDecoder(charset, { fatal: true }).decode(buffer); } catch { throw new FeedFetchError('INVALID_FEED'); }
        return { notModified: false, feed: parseFeed(xml, url.href), etag, lastModified, finalUrl: url.href };
      }
      throw new FeedFetchError('HTTP_ERROR');
    } catch (error) {
      if (error instanceof FeedFetchError) throw error;
      throw new FeedFetchError(signal.aborted ? 'TIMEOUT' : 'NETWORK');
    }
  };
}
export const fetchFeed = createFeedFetcher();

export function createRssPhotoFetcher(options: {
  lookup?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>; transport?: FeedTransport; timeoutMs?: number;
} = {}): RssPhotoFetcher {
  return async (input, callerSignal, maxBytes = RSS_PHOTO_MAX_SOURCE_BYTES) => {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > RSS_PHOTO_MAX_SOURCE_BYTES) throw new FeedFetchError('TOO_LARGE');
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]);
    let url = new URL(normalizeFeedUrl(input));
    try {
      for (let redirect = 0; redirect <= 4; redirect++) {
        signal.throwIfAborted();
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable((options.lookup ?? resolveFeedAddresses)(host, signal), signal);
        if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new FeedFetchError('UNSAFE_URL');
        signal.throwIfAborted();
        const headers = { 'user-agent': 'MisakaRSS/0.1', accept: 'image/jpeg, image/png, image/webp, image/avif;q=0.9, image/svg+xml;q=0.8, application/octet-stream;q=0.5', 'accept-encoding': 'identity' };
        let received: FeedTransportResponse | undefined;
        const pending = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return (options.transport ?? transport)(url, { addresses, headers, signal });
        }).then(response => {
          received = response;
          // An injected or delayed transport may finish after cancellation; never leave its body open.
          if (signal.aborted) { response.body.destroy(); throw new FeedFetchError('TIMEOUT'); }
          return response;
        });
        try {
          const response = await abortable(pending, signal);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.headers.location || redirect === 4) throw new FeedFetchError('HTTP_ERROR', response.status);
            url = new URL(normalizeFeedUrl(new URL(response.headers.location, url).href));
            continue;
          }
          if (response.status !== 200) throw new FeedFetchError(response.status === 401 || response.status === 403 ? 'BLOCKED' : 'HTTP_ERROR', response.status);
          if (Number(response.headers['content-length']) > maxBytes) throw new FeedFetchError('TOO_LARGE');
          const mime = (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
          if (!['', 'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml', 'application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(mime)) throw new FeedFetchError('INVALID_FEED');
          // Batch callers account returned bytes; forbid a differently sized compressed transfer.
          const encoding = response.headers['content-encoding']?.trim().toLowerCase();
          if (encoding && encoding !== 'identity') throw new FeedFetchError('INVALID_FEED');
          return await readBody(response, signal, maxBytes);
        } finally { received?.body.destroy(); }
      }
      throw new FeedFetchError('HTTP_ERROR');
    } catch (error) {
      if (error instanceof FeedFetchError) throw error;
      throw new FeedFetchError(signal.aborted ? 'TIMEOUT' : 'NETWORK');
    }
  };
}
export const fetchRssPhoto = createRssPhotoFetcher();
