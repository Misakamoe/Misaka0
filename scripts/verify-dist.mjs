import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

await stat('dist/src/index.js');
await stat('webui/dist/index.html');
let count = 0;
async function verify(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await verify(path);
    else {
      if (entry.name.endsWith('.map')) throw new Error(`Unexpected public source map: ${path}`);
      if (/\.(?:js|html|css|json)$/.test(entry.name)) {
        const content = await readFile(path, 'utf8');
        if (/MISAKA_BOT_TOKEN|MISAKA_OIDC_CLIENT_SECRET|legacy\/ptb|src\/config\.ts/.test(content)) throw new Error(`Private boundary found in public bundle: ${path}`);
        count += 1;
      }
    }
  }
}
await verify('webui/dist');
const manifestBytes = await readFile('dist/sandbox/manifest.json');
if (manifestBytes.length > 16_384) throw new Error('Oversized sandbox manifest');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const { LOCAL_SANDBOX_POLICY_SHA256, verifyLocalSandboxBuildIdentity } = await import('../dist/src/ai/local-sandbox.js');
const policy = createHash('sha256').update(await readFile('scripts/sandbox-runner.c')).update('\0')
  .update(await readFile('scripts/sandbox-smoke.mjs')).digest('hex');
if (manifest.version !== 1 || manifest.policyHash !== policy || policy !== LOCAL_SANDBOX_POLICY_SHA256
  || typeof manifest.available !== 'boolean') throw new Error('Sandbox build does not match reviewed source');
if (manifest.available) {
  const binary = 'dist/sandbox/sandbox-runner';
  if ((await stat(binary)).size > 4 * 1024 * 1024) throw new Error('Oversized sandbox supervisor');
  verifyLocalSandboxBuildIdentity(await readFile(binary), manifestBytes);
} else {
  if (typeof manifest.reason !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(manifest.reason)) throw new Error('Invalid unavailable sandbox manifest');
  console.log(`Local sandbox bundle unavailable: ${manifest.reason}; no native qualification is claimed.`);
}
console.log(`Verified ${count} public build artifacts and compiled Node entry point.`);
