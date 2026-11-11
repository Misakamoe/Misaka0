import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillService, skillReviewDigest, type InstalledSkill } from '../src/ai/skills.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('holds directory descriptors across an ancestor symlink substitution, never reading its target', async () => {
  const root = await mkdtemp('/tmp/kilo/ai-skill-race-'); roots.push(root);
  await mkdir(join(root, 'reviewed'));
  await mkdir(join(root, 'outside'));
  const text = '---\nname: reviewed\ndescription: Reviewed source.\n---\napproved';
  await writeFile(join(root, 'reviewed', 'SKILL.md'), text);
  await writeFile(join(root, 'outside', 'SKILL.md'), 'synthetic-private-data-not-to-be-read');
  const scope = { ownerId: '1', audience: 'private:1' };
  const entry: InstalledSkill = { id: 'reviewed', path: 'reviewed', enabled: true, files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(text).digest('hex') }], scopes: [scope], approvedTools: [], reviewedDigest: '' };
  entry.reviewedDigest = skillReviewDigest(entry);
  const nativeOpen = vi.mocked(open).getMockImplementation()!;
  let replaced = false;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await nativeOpen(path, flags, mode);
    if (!replaced && String(path).endsWith('/reviewed') && typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0) {
      replaced = true;
      await rename(join(root, 'reviewed'), join(root, 'original'));
      await symlink(join(root, 'outside'), join(root, 'reviewed'));
    }
    return handle;
  });
  const service = new SkillService({ root, catalog: () => [entry] });
  expect((await service.load('reviewed', scope)).body).toBe('approved');
  expect(replaced).toBe(true);
  await expect(service.load('reviewed', scope)).rejects.toThrow('INVALID_EXTENSION');
});

it('rejects concurrent bundle reads instead of retaining an unbounded work queue', async () => {
  const root = await mkdtemp('/tmp/kilo/ai-skill-admission-'); roots.push(root);
  await mkdir(join(root, 'reviewed'));
  const text = '---\nname: reviewed\ndescription: Reviewed source.\n---\napproved';
  await writeFile(join(root, 'reviewed', 'SKILL.md'), text);
  const scope = { ownerId: '1', audience: 'private:1' };
  const entry: InstalledSkill = { id: 'reviewed', path: 'reviewed', enabled: true, files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(text).digest('hex') }], scopes: [scope], approvedTools: [], reviewedDigest: '' };
  entry.reviewedDigest = skillReviewDigest(entry);
  const service = new SkillService({ root, catalog: () => [entry] });
  const first = service.load('reviewed', scope);
  await expect(service.load('reviewed', scope)).rejects.toThrow('EXTENSION_LIMIT');
  await first;
});
