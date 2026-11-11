import { mkdtemp, open, readdir, readFile, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStickerZip } from '../src/modules/sticker-zip.js';

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, statfs: vi.fn(fs.statfs), open: vi.fn(fs.open) };
});
const directories: string[] = [];
const directory = async () => { const path = await mkdtemp(join(process.cwd(), '.kilo', 'sticker-zip-test-')); directories.push(path); return path; };
const signal = () => new AbortController().signal;
afterEach(async () => { vi.mocked(statfs).mockReset(); vi.mocked(open).mockReset(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('finalized disk sticker ZIPs', () => {
  it('retains one original at a time, validates all entries before upload, and removes the real job files', async () => {
    const root = await directory(); let produced = 0; let filePath = '';
    async function* entries() {
      for (let i = 1; i <= 120; i++) { produced++; yield { name: `${String(i).padStart(3, '0')}.webp`, data: Buffer.from(`original-${i}`) }; }
    }
    await withStickerZip(root, entries(), signal(), async file => {
      filePath = file.path; expect(produced).toBe(120);
      const data = await readFile(file.path); expect(data.length).toBe(file.size);
      const output = unzipSync(data); expect(Object.keys(output)).toHaveLength(120);
      expect(Buffer.from(output['120.webp']!).toString()).toBe('original-120');
    });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['entry', 'capacity', 'cancel'] as const)('fails the entire archive on late %s without invoking send, and cleans up', async mode => {
    const root = await directory(); const controller = new AbortController(); const consume = vi.fn();
    async function* entries() {
      yield { name: '001.webp', data: Buffer.alloc(8 * 1024 * 1024) };
      if (mode === 'cancel') controller.abort();
      if (mode === 'entry') throw new Error('late untrusted failure');
      yield { name: '002.webp', data: Buffer.alloc(8 * 1024 * 1024) };
      yield { name: '003.webp', data: Buffer.alloc(5 * 1024 * 1024) };
    }
    await expect(withStickerZip(root, entries(), controller.signal, consume)).rejects.toHaveProperty('code');
    expect(consume).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it('rereads payload CRCs and rejects a corrupted early entry after the final entry is received', async () => {
    const root = await directory(); const consume = vi.fn();
    async function* entries() {
      yield { name: '001.webp', data: Buffer.from('original') };
      const job = (await readdir(root))[0]!;
      const file = await open(join(root, job, 'stickers.zip'), 'r+');
      try { await file.write(Buffer.from('X'), 0, 1, 30 + '001.webp'.length); }
      finally { await file.close(); }
      yield { name: '002.png', data: Buffer.from('second') };
    }
    await expect(withStickerZip(root, entries(), signal(), consume)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(consume).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it('does not redirect to tmpfs or another namespace when disk space is unavailable', async () => {
    const root = await directory(); const fs = await statfs(root); const consume = vi.fn();
    async function* entries() { yield { name: '001.webp', data: Buffer.from('original') }; }
    for (const status of [{ ...fs, bavail: 0 }, { ...fs, type: 0x01021994 }]) {
      vi.mocked(statfs).mockResolvedValueOnce(status as never);
      await expect(withStickerZip(root, entries(), signal(), consume)).rejects.toMatchObject({ code: 'CAPACITY' });
    }
    await expect(withStickerZip(undefined, entries(), signal(), consume)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(consume).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it('removes a partially written file after real file-handle write failure', async () => {
    const root = await directory(); const consume = vi.fn();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const write = handle.write.bind(handle);
      vi.spyOn(handle, 'write').mockImplementationOnce(write).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      return handle;
    });
    async function* entries() { yield { name: '001.webp', data: Buffer.from('original') }; }
    await expect(withStickerZip(root, entries(), signal(), consume)).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(consume).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it('cleans up an uncertain upload exactly once with no fallback delivery', async () => {
    const root = await directory(); const consume = vi.fn(async () => { throw new Error('connection lost'); });
    async function* entries() { yield { name: '001.webp', data: Buffer.from('original') }; }
    await expect(withStickerZip(root, entries(), signal(), consume)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(consume).toHaveBeenCalledTimes(1); expect(await readdir(root)).toEqual([]);
  });
});
