import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
console.log(`Verified ${count} public build artifacts and compiled Node entry point.`);
