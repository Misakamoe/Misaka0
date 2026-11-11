import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm, statfs, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { AppError, throwIfAborted } from '../errors.js';

export interface StickerZipFile { path: string; size: number }
const MAX_ARCHIVE = 21 * 1024 * 1024;
const MAX_ORIGINALS = 20 * 1024 * 1024;

// Only the configured new-core namespace is touched. In particular, /tmp may be
// RAM-backed; refusing tmpfs is intentional, not a fallback to another directory.
export async function withStickerZip<T>(directory: string | undefined, entries: AsyncIterable<{ name: string; data: Buffer }>, signal: AbortSignal,
  consume: (file: StickerZipFile) => Promise<T>): Promise<T> {
  if (!directory || !isAbsolute(directory)) throw new AppError('UNAVAILABLE');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  const fs = await statfs(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
    || fs.type === 0x01021994 || fs.bavail * fs.bsize < MAX_ARCHIVE) throw new AppError('CAPACITY');
  const job = await mkdtemp(join(directory, 'pack-'));
  let handle: FileHandle | undefined;
  let delivered = false;
  try {
    const path = join(job, 'stickers.zip');
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    let size = 0;
    let originals = 0;
    const records: { local: Buffer; central: Buffer; offset: number; bytes: number; crc: number }[] = [];
    const names = new Set<string>();
    const write = async (data: Buffer) => {
      if (size + data.length > MAX_ARCHIVE) throw new AppError('CAPACITY');
      for (let offset = 0; offset < data.length;) {
        throwIfAborted(signal);
        const result = await handle!.write(data, offset, Math.min(64 * 1024, data.length - offset), size);
        if (!result.bytesWritten) throw new AppError('STORAGE_ERROR');
        offset += result.bytesWritten; size += result.bytesWritten;
      }
    };
    for await (const { name, data } of entries) {
      throwIfAborted(signal);
      if (!/^\d{3}\.(?:png|webp|tgs|webm)$/.test(name) || names.has(name) || records.length >= 120
        || !Buffer.isBuffer(data) || !data.length || data.length > 8 * 1024 * 1024) throw new AppError('INVALID_INPUT');
      names.add(name);
      originals += data.length;
      if (originals > MAX_ORIGINALS) throw new AppError('CAPACITY');
      const filename = Buffer.from(name);
      const crc = crc32(data);
      const local = Buffer.alloc(30 + filename.length);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
      const central = Buffer.alloc(46 + filename.length);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(33, 14);
      central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(size, 42); filename.copy(central, 46);
      records.push({ local, central, offset: size, bytes: data.length, crc });
      await write(local); await write(data);
    }
    if (!records.length) throw new AppError('INVALID_INPUT');
    const indexOffset = size;
    const index = Buffer.concat(records.map(record => record.central));
    await write(index);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
    end.writeUInt32LE(index.length, 12); end.writeUInt32LE(indexOffset, 16);
    await write(end);
    await handle.sync();
    if ((await handle.stat()).size !== size) throw new AppError('STORAGE_ERROR');
    const scratch = Buffer.allocUnsafe(64 * 1024);
    const read = async (offset: number, length: number) => {
      let filled = 0;
      while (filled < length) {
        throwIfAborted(signal);
        const { bytesRead } = await handle!.read(scratch, filled, length - filled, offset + filled);
        if (!bytesRead) throw new AppError('STORAGE_ERROR');
        filled += bytesRead;
      }
      return scratch.subarray(0, length);
    };
    for (const record of records) {
      if (!(await read(record.offset, record.local.length)).equals(record.local)) throw new AppError('STORAGE_ERROR');
      let crc = 0;
      for (let offset = 0; offset < record.bytes;) {
        const bytes = Math.min(scratch.length, record.bytes - offset);
        crc = crc32(await read(record.offset + record.local.length + offset, bytes), crc); offset += bytes;
      }
      if (crc !== record.crc) throw new AppError('STORAGE_ERROR');
    }
    if (!(await read(indexOffset, index.length)).equals(index) || !(await read(indexOffset + index.length, end.length)).equals(end)) throw new AppError('STORAGE_ERROR');
    await handle.close(); handle = undefined;
    throwIfAborted(signal);
    delivered = true;
    return await consume({ path, size });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(delivered ? 'OUTCOME_UNKNOWN' : 'CAPACITY');
  } finally {
    await handle?.close();
    await rm(job, { recursive: true, force: true }).catch(() => Promise.reject(new AppError(delivered ? 'OUTCOME_UNKNOWN' : 'STORAGE_ERROR')));
  }
}
