import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('legacy/ptb/manifest.json', root), 'utf8'));
for (const file of manifest.files.filter(file => file.archive)) {
  const digest = createHash('sha256').update(await readFile(new URL(file.archive, root))).digest('hex');
  if (digest !== file.sha256) throw new Error(`Archive content changed: ${file.path}`);
}
console.log(`Verified ${manifest.files.filter(file => file.archive).length} unchanged legacy files.`);
