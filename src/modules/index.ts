import type { ModuleMetadata } from '../../shared/schemas/index.js';
import { aliasMetadata } from './alias.js';
import { rssMetadata } from './rss.js';
import { rateMetadata } from './rate.js';
import { weatherMetadata } from './weather.js';
import { stickerMetadata } from './sticker.js';
import { subconvMetadata } from './subconv.js';

// Explicit registry only. Archived Python modules are not runtime dependencies.
export const modules: readonly { metadata: ModuleMetadata }[] = Object.freeze([{ metadata: aliasMetadata }, { metadata: rssMetadata }, { metadata: rateMetadata }, { metadata: weatherMetadata }, { metadata: stickerMetadata }, { metadata: subconvMetadata }]);
