import type { ModuleMetadata } from '../../shared/schemas/index.js';
import { aliasMetadata, rssMetadata, rateMetadata, weatherMetadata, stickerMetadata, subconvMetadata, relayMetadata } from './metadata.js';

// Explicit registry only. Archived Python modules are not runtime dependencies.
export const modules: readonly { metadata: ModuleMetadata }[] = Object.freeze([{ metadata: aliasMetadata }, { metadata: rssMetadata }, { metadata: rateMetadata }, { metadata: weatherMetadata }, { metadata: stickerMetadata }, { metadata: subconvMetadata }, { metadata: relayMetadata }]);
