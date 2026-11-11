import { AppError } from '../errors.js';
import type { AiCapturedFile } from './telegram-port.js';

export function validateAiFile(file: AiCapturedFile, input: Uint8Array): void {
  if (!input.byteLength || input.byteLength !== file.size || input.byteLength > 1_048_576) throw new AppError('CAPACITY');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const starts = (signature: string, offset = 0) => bytes.subarray(offset, offset + signature.length).toString('latin1') === signature;
  let valid = false;
  let width = 0; let height = 0;
  if (file.kind === 'sticker' && file.mimeType === 'application/x-tgsticker' && starts('\x1f\x8b\x08') && bytes.length <= 65_536) return;
  if (file.kind === 'sticker' && file.mimeType === 'video/webm' && starts('\x1a\x45\xdf\xa3')) return;
  if (file.kind === 'image' || file.kind === 'sticker') {
    if (file.mimeType === 'image/png' && bytes.length >= 33 && starts('\x89PNG\r\n\x1a\n') && starts('IHDR', 12)) {
      width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); valid = true;
    } else if (file.mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
      for (let at = 2; at + 8 < bytes.length;) {
        if (bytes[at++] !== 0xff) break;
        while (bytes[at] === 0xff) at++;
        const marker = bytes[at++]!;
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        if (at + 2 > bytes.length) break;
        const length = bytes.readUInt16BE(at);
        if (length < 2 || at + length > bytes.length) break;
        if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
          height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); valid = true; break;
        }
        at += length;
      }
    } else if (file.mimeType === 'image/webp' && bytes.length >= 30 && starts('RIFF') && starts('WEBP', 8)
      && bytes.readUInt32LE(4) + 8 === bytes.length) {
      if (starts('VP8X', 12)) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); valid = true; }
      else if (starts('VP8 ', 12) && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; valid = true;
      } else if (starts('VP8L', 12) && bytes[20] === 0x2f) {
        const dimensions = bytes.readUInt32LE(21); width = (dimensions & 0x3fff) + 1; height = (dimensions >>> 14 & 0x3fff) + 1; valid = true;
      }
    } else if (file.mimeType === 'image/gif' && bytes.length >= 13 && (starts('GIF87a') || starts('GIF89a'))) {
      width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); valid = true;
    }
    if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4_000_000) throw new AppError('CAPACITY');
  } else if (file.kind === 'audio') {
    valid = file.mimeType === 'audio/ogg' && starts('OggS') || file.mimeType === 'audio/flac' && starts('fLaC')
      || ['audio/wav', 'audio/x-wav'].includes(file.mimeType) && starts('RIFF') && starts('WAVE', 8)
      || file.mimeType === 'audio/mp4' && bytes.length >= 24 && starts('ftyp', 4)
      || ['audio/mpeg', 'audio/mp3'].includes(file.mimeType) && (starts('ID3') || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
      || file.mimeType === 'audio/aac' && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
  } else if (file.mimeType === 'application/pdf') valid = starts('%PDF-');
  else if (file.mimeType === 'text/plain') {
    try { valid = !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0'); } catch { valid = false; }
  }
  if (!valid) throw new AppError('INVALID_INPUT');
}
