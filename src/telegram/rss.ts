import { GrammyError, InputFile, type Bot } from 'grammy';
import type { RichText } from 'grammy/types';
import { translator } from '../i18n.js';
import { FEED_MAX_IMAGES, RSS_PHOTO_MAX_SOURCE_BYTES, contentLinkUrl, findFeedLinks, isGifImageUrl, type FeedEntry, type FeedLink } from '../modules/rss-feed.js';
import { RSS_PHOTO_MAX_OUTPUT_BYTES, RSS_PHOTO_MAX_REPAIR_BYTES, createRssPhotoPreparer, type RssPhotoPreparer } from '../modules/rss-photo.js';
import { feedContentFormatSchema, isValidFeedContentFormat, type FeedContentBlock, type FeedRange, type FeedTextRange } from '../modules/rss-format.js';
import { RSS_IMAGES_PER_MESSAGE, RssDeliveryError, type RssOptions } from '../modules/rss.js';
import type { ResourcePolicy } from '../resources.js';
import { telegramSignal, type ApiHealth } from './effects.js';

const PREVIEW_LENGTH = 120;
const PHOTO_REPAIR_TIMEOUT_MS = 20_000;
type RichBlocks = NonNullable<Parameters<Bot['api']['sendRichMessage']>[1]['blocks']>;

function uploadedPhotos(blocks: RichBlocks, photos: ReadonlyMap<string, Buffer>): RichBlocks {
  return blocks.flatMap((block): RichBlocks => {
    if (block.type === 'photo' && typeof block.photo.media === 'string') {
      const data = photos.get(block.photo.media);
      if (data) return [{ ...block, photo: { ...block.photo, media: new InputFile(data, 'rss-preview.jpg') } }];
    }
    if (block.type === 'slideshow') {
      const repaired = uploadedPhotos(block.blocks, photos);
      return repaired.length > 1 ? [{ ...block, blocks: repaired }] : repaired;
    }
    // Never carry a failed remote reference or an unrepaired animation into the upload retry.
    return [];
  });
}

function contentText(content: string, links: readonly FeedLink[], from = 0, to = content.length): RichText {
  const parts: RichText[] = [];
  let offset = from;
  for (const link of links) {
    if (link.offset >= to) break;
    const url = contentLinkUrl(link.url);
    const start = Math.max(from, link.offset);
    const end = Math.min(link.offset + link.length, to);
    if (!url || start < offset || end <= start) continue;
    if (start > offset) parts.push(content.slice(offset, start));
    parts.push({ type: 'url', text: content.slice(start, end), url });
    offset = end;
  }
  if (offset < to) parts.push(content.slice(offset, to));
  return parts.length === 1 ? parts[0]! : parts;
}

function positionedText(content: string, links: readonly FeedLink[], positions: NonNullable<FeedEntry['imagePositions']>, images: readonly string[], label: (index: number) => string): RichText {
  if (!positions.length) return contentText(content, links);
  const parts: RichText[] = [];
  let offset = 0; let previous = -1;
  for (const [index, position] of positions.entries()) {
    const at = position.offset;
    if (!Number.isSafeInteger(at) || at < offset || at > content.length || !Number.isSafeInteger(position.imageIndex)
      || position.imageIndex < 0 || position.imageIndex >= images.length
      || /[\uD800-\uDBFF]/.test(content.charAt(at - 1)) && /[\uDC00-\uDFFF]/.test(content.charAt(at))) throw new RssDeliveryError('REJECTED');
    if (at > offset) parts.push(contentText(content, links, offset, at));
    if (at === previous || at > 0 && !/\s/.test(content.charAt(at - 1))) parts.push(' ');
    // A marker is its own link, even when the image occurred inside an article hyperlink.
    parts.push({ type: 'url', text: label(position.imageIndex), url: images[position.imageIndex]! });
    if (positions[index + 1]?.offset !== at && at < content.length && !/\s/.test(content.charAt(at))) parts.push(' ');
    offset = at; previous = at;
  }
  if (offset < content.length) parts.push(contentText(content, links, offset));
  return parts;
}

function formattedBody(entry: FeedEntry, links: readonly FeedLink[], images: readonly string[], label: (index: number) => string): { blocks: RichBlocks; literals: FeedRange[] } {
  const content = entry.content;
  const positions = entry.imagePositions ?? [];
  const literals: FeedRange[] = [];
  const image = (occurrence: number): RichText => {
    const index = positions[occurrence]!.imageIndex;
    return { type: 'url', text: label(index), url: images[index]! };
  };
  const text = (range: FeedTextRange): RichText => {
    const end = range.offset + range.length;
    const spans = range.spans ?? [];
    literals.push(...spans.filter(span => span.type === 'code'));
    const at = new Map<number, number[]>();
    for (const occurrence of range.images ?? []) {
      const offset = positions[occurrence]!.offset;
      at.set(offset, [...(at.get(offset) ?? []), occurrence]);
    }
    const boundaries = [...new Set([range.offset, end, ...at.keys(),
      ...spans.flatMap(span => [span.offset, span.offset + span.length])])].sort((left, right) => left - right);
    const parts: RichText[] = [];
    for (const [index, start] of boundaries.entries()) {
      const markers = at.get(start) ?? [];
      for (const [marker, occurrence] of markers.entries()) {
        if (marker || start > range.offset && !/\s/.test(content.charAt(start - 1))) parts.push(' ');
        parts.push(image(occurrence));
      }
      if (markers.length && start < end && !/\s/.test(content.charAt(start))) parts.push(' ');
      const stop = boundaries[index + 1];
      if (stop === undefined || stop <= start) continue;
      const styles = new Set(spans.filter(span => span.offset <= start && span.offset + span.length >= stop).map(span => span.type));
      let part: RichText = styles.has('code') ? content.slice(start, stop) : contentText(content, links, start, stop);
      for (const type of ['bold', 'italic', 'underline', 'strikethrough', 'marked', 'code'] as const) {
        if (styles.has(type)) part = { type, text: part };
      }
      parts.push(part);
    }
    return parts.length === 1 ? parts[0]! : parts;
  };
  const gap = (from: number, to: number): RichBlocks => content.slice(from, to).trim()
    ? [{ type: 'paragraph', text: contentText(content, links, from, to) }] : [];
  const scope = (blocks: readonly FeedContentBlock[], from: number, to: number): RichBlocks => {
    const result: RichBlocks = [];
    let cursor = from;
    for (const block of blocks) {
      result.push(...gap(cursor, block.offset), ...render(block));
      cursor = block.offset + block.length;
    }
    result.push(...gap(cursor, to));
    return result;
  };
  const render = (block: FeedContentBlock): RichBlocks => {
    const end = block.offset + block.length;
    switch (block.type) {
      case 'paragraph': case 'heading': {
        if (!block.length && !block.images?.length) return [];
        const value = text(block);
        return [{ type: 'paragraph', text: block.type === 'heading' ? { type: 'bold', text: value } : value }];
      }
      case 'pre': {
        literals.push(block);
        const result: RichBlocks = block.length ? [{ type: 'pre', text: content.slice(block.offset, end), ...(block.language ? { language: block.language } : {}) }] : [];
        // Real image elements inside preformatted HTML stay outside the literal code block.
        if (block.images?.length) result.push({ type: 'paragraph', text: block.images.flatMap((occurrence, index) => index ? [' ', image(occurrence)] : [image(occurrence)]) });
        return result;
      }
      case 'table': {
        const columns = Math.max(...block.cells.map(row => row.length));
        return [{ type: 'table', is_bordered: true, is_compact: true,
          cells: block.cells.map(row => Array.from({ length: columns }, (_, index) => {
            const cell = row[index];
            return { text: cell ? text(cell) : '', align: cell?.align ?? 'left', valign: 'top', ...(cell?.header ? { is_header: true as const } : {}) };
          })),
        }];
      }
      case 'blockquote': return [{ type: 'blockquote', blocks: scope(block.blocks, block.offset, end) }];
      case 'list': {
        let cursor = block.offset;
        const items = block.items.map((children, index) => {
          const last = children.at(-1);
          const stop = index === block.items.length - 1 ? end : last ? last.offset + last.length : cursor;
          const blocks = scope(children, cursor, stop);
          cursor = stop;
          return { blocks, ...(block.ordered ? { type: '1' as const, value: (block.start ?? 1) + index } : {}) };
        }).filter(item => item.blocks.length);
        return items.length ? [{ type: 'list', items }] : [];
      }
      case 'divider': return [{ type: 'divider' }];
    }
  };
  return { blocks: scope(entry.contentFormat!.blocks, 0, content.length), literals };
}

export function createRssSender(bot: Bot, options: Partial<ApiHealth> & { resources?: Pick<ResourcePolicy, 'tryAcquire'> } = {}, prepare: RssPhotoPreparer = createRssPhotoPreparer(undefined, options)): RssOptions['send'] {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return async (target, source, payload, language, silent, signal) => {
    const t = translator(language);
    const blocks: NonNullable<Parameters<Bot['api']['sendRichMessage']>[1]['blocks']> = [];
    const media: typeof blocks = [];
    const imageLinks: { url: string; label: string; animation: boolean }[] = [];
    let staticPhotos: string[] = [];
    const attribution: RichText[] = [t('bot:rss.from', { source })];
    if (payload.kind === 'entry') {
      const entry = payload.entry;
      if (entry.contentFormat !== undefined) {
        const format = feedContentFormatSchema.safeParse(entry.contentFormat);
        if (!format.success || !isValidFeedContentFormat(format.data, entry.content, entry.imagePositions ?? [])) throw new RssDeliveryError('REJECTED');
      }
      const links = entry.contentLinks ?? (entry.contentFormat ? [] : findFeedLinks(entry.content));
      let previewLinks = links;
      const images = (entry.images ?? (entry.image ? [entry.image] : [])).map(image => {
        const url = contentLinkUrl(image);
        if (!url) throw new RssDeliveryError('REJECTED');
        return url;
      });
      const total = Math.max(1, Math.ceil(images.length / RSS_IMAGES_PER_MESSAGE));
      if (images.length > FEED_MAX_IMAGES || !payload.part && total > 1 || payload.part
        && (!Number.isSafeInteger(payload.part.index) || payload.part.index < 1 || payload.part.index > total || payload.part.total !== total)) throw new RssDeliveryError('REJECTED');
      const start = (payload.part ? payload.part.index - 1 : 0) * RSS_IMAGES_PER_MESSAGE;
      const selected = images.slice(start, start + RSS_IMAGES_PER_MESSAGE);
      const animations = new Set(entry.animationIndices ?? images.flatMap((image, index) => isGifImageUrl(image) ? [index] : []));
      if ([...animations].some(index => !Number.isSafeInteger(index) || index < 0 || index >= images.length)) throw new RssDeliveryError('REJECTED');
      const label = (index: number, position = false) => t(`bot:rss.${animations.has(index)
        ? position ? 'animationPosition' : 'animationLink' : position ? 'imagePosition' : 'imageLink'}`, { number: index + 1 });
      staticPhotos = selected.filter((_image, index) => !animations.has(start + index));
      if (selected.length) {
        const items = selected.map((image, index) => animations.has(start + index)
          ? { type: 'animation' as const, animation: { type: 'animation' as const, media: image } }
          : { type: 'photo' as const, photo: { type: 'photo' as const, media: image } });
        media.push(items.length === 1 ? items[0]! : { type: 'slideshow', blocks: items });
        for (const [index, image] of selected.entries()) {
          imageLinks.push({ url: image, label: label(start + index), animation: animations.has(start + index) });
        }
      }
      blocks.push({ type: 'paragraph', text: { type: 'bold', text: entry.title || t('bot:rss.untitled') } });
      if (payload.part) blocks.push({ type: 'paragraph', text: t('bot:rss.imagePart', { part: payload.part.index, total: payload.part.total }) });
      const first = !payload.part || payload.part.index === 1;
      const body: typeof blocks = [];
      let bodyLength = first ? entry.content.length : 0;
      if (first && (entry.content || entry.imagePositions?.length || entry.contentFormat)) {
        if (entry.contentFormat) {
          const formatted = formattedBody(entry, links, images, index => label(index, true));
          body.push(...formatted.blocks);
          previewLinks = links.filter(link => !formatted.literals.some(range => link.offset < range.offset + range.length && link.offset + link.length > range.offset));
        } else body.push({ type: 'paragraph', text: positionedText(entry.content, links, entry.imagePositions ?? [], images, index => label(index, true)) });
        bodyLength += entry.imagePositions?.reduce((length, position) => length + label(position.imageIndex, true).length + 2, 0) ?? 0;
      }
      // Missing metadata means an old queue entry, not proof that its images were attachments.
      if (entry.imagePositions !== undefined) {
        const located = new Set(entry.imagePositions.map(position => position.imageIndex));
        const attached: RichText[] = [t('bot:rss.attachedImages')];
        for (const [index, image] of selected.entries()) if (!located.has(start + index)) {
          attached.push(' ', { type: 'url', text: label(start + index), url: image });
          bodyLength += label(start + index).length + 1;
        }
        if (attached.length > 1) {
          body.push({ type: 'paragraph', text: attached });
          bodyLength += t('bot:rss.attachedImages').length;
        }
      }
      if (bodyLength > PREVIEW_LENGTH * 2) {
        if (first && entry.content) {
          const preview = entry.content.slice(0, PREVIEW_LENGTH - 3).replace(/[\uD800-\uDBFF]$/, '');
          blocks.push({ type: 'paragraph', text: preview.length < entry.content.length ? [contentText(preview, previewLinks), '...'] : contentText(preview, previewLinks) });
        }
        blocks.push({ type: 'details', summary: { type: 'marked', text: { type: 'bold', text: t('bot:rss.read') } }, blocks: body });
      } else {
        blocks.push(...body);
      }
      const original = entry.url && contentLinkUrl(entry.url);
      if (original) attribution.push(' ', { type: 'button', button: { text: t('bot:rss.original'), url: original, style: 'primary' } });
      if (entry.publishedAt) attribution.unshift(new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(entry.publishedAt)), '\n');
    } else {
      blocks.push({ type: 'paragraph', text: { type: 'bold', text: t(payload.recovered ? 'bot:rss.recovered' : 'bot:rss.unhealthy') } });
      if (payload.error) blocks.push({ type: 'paragraph', text: t(`bot:rss.errors.${payload.error}`) });
    }
    blocks.push({ type: 'blockquote', blocks: [{ type: 'paragraph', text: attribution }] });
    const deliver = (images: boolean, photos?: ReadonlyMap<string, Buffer>) => {
      const omitted = images && !photos ? [] : imageLinks.filter(image => image.animation || !photos?.has(image.url));
      const imageFallback: RichBlocks = omitted.length ? [
        { type: 'paragraph', text: t('bot:rss.imagesUnavailable') },
        { type: 'paragraph', text: omitted.flatMap<RichText>((image, index) => [
          ...(index ? [' | '] : []), { type: 'url', text: image.label, url: image.url },
        ]) },
      ] : [];
      return bot.api.sendRichMessage(target.chatId, {
        blocks: [...(images ? photos ? uploadedPhotos(media, photos) : media : []), blocks[0]!, ...imageFallback, ...blocks.slice(1)], skip_entity_detection: true,
      }, { message_thread_id: target.threadId, disable_notification: silent }, telegramSignal(signal));
    };
    try {
      try { await deliver(true); }
      catch (error) {
        if (!(error instanceof GrammyError && error.error_code === 400 && media.length)) throw error;
        if (staticPhotos.length && /failed to get http|wrong type of the web page content|wrong file identifier|(?:photo|image)_[a-z_]+|webpage_(?:curl_failed|media_empty)|file (?:is )?too (?:big|large)/i.test(error.description)) {
          const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(PHOTO_REPAIR_TIMEOUT_MS)]);
          const photos = new Map<string, Buffer>();
          let sourceRemaining = RSS_PHOTO_MAX_SOURCE_BYTES * 2; let uploadBytes = 0;
          for (const image of staticPhotos) {
            if (repairSignal.aborted || sourceRemaining <= 0) break;
            const allowance = Math.min(RSS_PHOTO_MAX_REPAIR_BYTES, sourceRemaining);
            // Reserve the preparer's 8 MiB cap; failures keep it so unknown partial bytes cannot bypass 40 MiB.
            sourceRemaining -= allowance;
            try {
              const prepared = await prepare(image, repairSignal, allowance);
              if (!Number.isSafeInteger(prepared.sourceBytes) || prepared.sourceBytes <= 0 || prepared.sourceBytes > allowance
                || !Buffer.isBuffer(prepared.data) || !prepared.data.length || prepared.data.length > RSS_PHOTO_MAX_OUTPUT_BYTES) continue;
              sourceRemaining += allowance - prepared.sourceBytes;
              if (uploadBytes + prepared.data.length > RSS_PHOTO_MAX_OUTPUT_BYTES * 2) break;
              uploadBytes += prepared.data.length;
              photos.set(image, prepared.data);
            } catch {
              if (signal.aborted) signal.throwIfAborted();
            }
          }
          signal.throwIfAborted();
          if (photos.size) {
            try { await deliver(true, photos); return; }
            catch (uploadError) {
              if (!(uploadError instanceof GrammyError && uploadError.error_code === 400)) throw uploadError;
            }
          }
        }
        // Every preceding delivery was definitely rejected. Keep originals if repair is unavailable or also rejected.
        signal.throwIfAborted();
        await deliver(false);
      }
    } catch (error) {
      if (!signal.aborted) options.recordApiError?.(error instanceof GrammyError ? `TELEGRAM_${error.error_code}` : 'TELEGRAM_UNAVAILABLE');
      if (error instanceof GrammyError && error.error_code === 429) throw new RssDeliveryError('RATE_LIMITED', (error.parameters.retry_after ?? 60) * 1000);
      if (error instanceof GrammyError && error.error_code === 403) throw new RssDeliveryError('BLOCKED');
      if (error instanceof GrammyError && error.error_code === 400) throw new RssDeliveryError('REJECTED');
      throw new RssDeliveryError('UNKNOWN');
    }
  };
}
