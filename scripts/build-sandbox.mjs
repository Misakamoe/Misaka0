import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(new URL('./sandbox-runner.c', import.meta.url));
const smoke = await readFile(new URL('./sandbox-smoke.mjs', import.meta.url));
const policyHash = createHash('sha256').update(source).update('\0').update(smoke).digest('hex');
const requireAvailable = process.argv.length === 3 && process.argv[2] === '--require-available';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--policy-hash' && process.argv.length === 3) console.log(policyHash);
  else {
    if (process.argv.length !== 2 && !requireAvailable) throw new Error('No caller-selected compiler, runtime, inputs or output paths are supported.');
    await build();
  }
}

export function sandboxRuntimeMode(path) {
  return path === 'usr/bin/node' || /(?:^|\/)ld-linux-x86-64\.so\.2$/.test(path) ? 0o555 : 0o444;
}

// Data only: the build's private captured bytes, not a subsequently reopened
// source pathname. A returned copy cannot mutate the captured policy input.
export function capturedSandboxCompilation(binary) {
  return {
    args: ['-std=gnu11', '-O2', '-static', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2',
      '-Wall', '-Wextra', '-Werror=implicit-function-declaration', `-DPOLICY_SHA256="${policyHash}"`,
      '-o', binary, '-x', 'c', '-'],
    input: Buffer.from(source),
  };
}

export function pinSandboxAdapter(adapter, identity, expectedPolicy) {
  const marker = /^export const LOCAL_SANDBOX_BUILD_IDENTITY = ['"][A-Za-z0-9_:]*['"];$/gm;
  if (adapter.match(marker)?.length !== 1 || !adapter.includes(`LOCAL_SANDBOX_POLICY_SHA256 = '${expectedPolicy}'`)
    || !/^(?:[a-f0-9]{64}:[a-f0-9]{64}|UNAVAILABLE:[A-Z0-9_]+)$/.test(identity)) throw new Error('COMPILED_ADAPTER_IDENTITY_MISSING');
  return adapter.replace(marker, `export const LOCAL_SANDBOX_BUILD_IDENTITY = '${identity}';`);
}

async function safeDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o022) || await realpath(path) !== path) throw new Error('UNSAFE_BUILD_DIRECTORY');
}

async function trustedFile(path, maxBytes = 160 * 1024 * 1024) {
  const canonical = await realpath(path);
  const fd = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o6022) || ![0, process.getuid()].includes(info.uid)
      || info.size > maxBytes) throw new Error('UNSAFE_BUILD_INPUT');
    return await fd.readFile();
  } finally { await fd.close(); }
}

// Parse ELF metadata as data. Never use ldd (which may execute the target), or
// execute a selected runtime to discover libraries. Only glibc x86-64 is reviewed.
function elf(bytes) {
  if (bytes.length < 64 || bytes.toString('hex', 0, 7) !== '7f454c46020101' || bytes.readUInt16LE(18) !== 62) throw new Error('UNSUPPORTED_ELF');
  const phoff = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (size !== 56 || count > 64 || phoff + size * count > bytes.length) throw new Error('INVALID_ELF');
  const headers = Array.from({ length: count }, (_, i) => {
    const at = phoff + i * size;
    return { type: bytes.readUInt32LE(at), offset: Number(bytes.readBigUInt64LE(at + 8)), address: Number(bytes.readBigUInt64LE(at + 16)), length: Number(bytes.readBigUInt64LE(at + 32)) };
  });
  const string = (offset) => {
    const end = bytes.indexOf(0, offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || end < offset || end - offset > 240) throw new Error('INVALID_ELF_STRING');
    return bytes.toString('utf8', offset, end);
  };
  const interp = headers.find((h) => h.type === 3);
  const dynamic = headers.find((h) => h.type === 2);
  const needed = []; let strtab;
  if (dynamic) {
    if (dynamic.length > 65536 || dynamic.offset + dynamic.length > bytes.length) throw new Error('INVALID_ELF_DYNAMIC');
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.length; at += 16) {
      const tag = Number(bytes.readBigUInt64LE(at)), value = Number(bytes.readBigUInt64LE(at + 8));
      if (!tag) break;
      if (tag === 5) strtab = value;
      if (tag === 1) needed.push(value);
      if (tag === 15 || tag === 29) throw new Error('ELF_RPATH_NOT_SUPPORTED');
    }
  }
  const load = headers.find((h) => h.type === 1 && strtab >= h.address && strtab < h.address + h.length);
  if (needed.length && !load) throw new Error('INVALID_ELF_STRTAB');
  return { interpreter: interp ? string(interp.offset) : undefined,
    dynamic: Boolean(dynamic), needed: needed.map((offset) => string(load.offset + strtab - load.address + offset)) };
}

async function build() {
  await safeDirectory(project.replace(/\/$/, ''));
  const dist = join(project, 'dist');
  await mkdir(dist, { recursive: true, mode: 0o755 });
  await safeDirectory(dist);
  const stage = await mkdtemp(join(dist, '.sandbox-build-'));
  const output = join(dist, 'sandbox');
  let published = false;
  try {
    const manifest = { version: 1, platform: 'linux', arch: 'x64', policyHash, available: false, reason: '', binarySha256: '', files: [] };
    try {
      if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') throw new Error('LINUX_X64_NODE24_REQUIRED');
      const wrapper = await readFile(join(project, 'src/ai/local-sandbox.ts'), 'utf8');
      if (!wrapper.includes(`LOCAL_SANDBOX_POLICY_SHA256 = '${policyHash}'`)) throw new Error('REVIEWED_POLICY_HASH_MISMATCH');
      let compiler;
      for (const candidate of ['/usr/bin/cc', '/usr/bin/gcc', '/usr/bin/clang']) {
        try { const path = await realpath(candidate); const info = await lstat(path);
          if (info.isFile() && info.uid === 0 && !(info.mode & 0o6022)) { compiler = path; break; }
          console.warn(`Local sandbox compiler ${candidate}: untrusted (file type, ownership or mode).`);
        } catch (error) {
          const category = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing'
            : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission-denied' : 'inspection-failed';
          // Only fixed candidate paths and categories, never error messages or resolved targets.
          console.warn(`Local sandbox compiler ${candidate}: ${category}.`);
        }
      }
      if (!compiler) throw new Error('C_COMPILER_UNAVAILABLE');
      const binary = join(stage, 'sandbox-runner');
      const compilation = capturedSandboxCompilation(binary);
      await new Promise((resolveCompile, reject) => {
        const child = spawn(compiler, compilation.args, {
          cwd: project, env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: stage }, shell: false, stdio: ['pipe', 'inherit', 'inherit'],
        });
        child.once('error', reject);
        child.stdin.once('error', reject);
        child.once('close', (code) => code === 0 ? resolveCompile() : reject(new Error('SUPERVISOR_COMPILE_FAILED')));
        child.stdin.end(compilation.input);
      });
      await chmod(binary, 0o555);
      const executable = await trustedFile(binary, 4 * 1024 * 1024);
      const supervisor = elf(executable);
      if (supervisor.interpreter || supervisor.dynamic || supervisor.needed.length) throw new Error('STATIC_SUPERVISOR_REQUIRED');
      manifest.binarySha256 = createHash('sha256').update(executable).digest('hex');
      const root = join(stage, 'root');
      for (const directory of ['input', 'work', 'tmp', 'proc', 'old', 'usr/bin', 'usr/lib/misaka']) await mkdir(join(root, directory), { recursive: true, mode: 0o755 });
      const seen = new Set(); let total = 0;
      const add = async (path, bytes) => {
        if (seen.has(path)) return;
        if (!/^(?:usr\/bin\/node|usr\/lib\/misaka\/smoke\.mjs|(?:usr\/)?lib(?:64|\/x86_64-linux-gnu)?\/[A-Za-z0-9_.+-]+\.so(?:\.[A-Za-z0-9_.+-]+)?)$/.test(path)) throw new Error('RUNTIME_PATH_REJECTED');
        seen.add(path); total += bytes.length;
        if (seen.size > 48 || total > 192 * 1024 * 1024) throw new Error('RUNTIME_CLOSURE_TOO_LARGE');
        await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o755 });
        const mode = sandboxRuntimeMode(path);
        await writeFile(join(root, path), bytes, { flag: 'wx', mode });
        await chmod(join(root, path), mode);
        if (((await lstat(join(root, path))).mode & 0o777) !== mode) throw new Error('RUNTIME_MODE_MISMATCH');
        manifest.files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mode });
      };
      const libraries = ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64', '/usr/lib64', '/lib', '/usr/lib'];
      const queue = [{ path: 'usr/bin/node', bytes: await trustedFile(process.execPath) }];
      while (queue.length) {
        const item = queue.shift();
        if (seen.has(item.path)) continue;
        await add(item.path, item.bytes);
        const metadata = elf(item.bytes);
        if (metadata.interpreter) {
          if (!/^\/(?:lib64|lib\/x86_64-linux-gnu)\/ld-linux-x86-64\.so\.2$/.test(metadata.interpreter)) throw new Error('GLIBC_LOADER_REQUIRED');
          queue.push({ path: metadata.interpreter.slice(1), bytes: await trustedFile(metadata.interpreter) });
        }
        for (const name of metadata.needed) {
          if (!/^[A-Za-z0-9_.+-]+\.so(?:\.[A-Za-z0-9_.+-]+)?$/.test(name)) throw new Error('INVALID_LIBRARY_NAME');
          let found = false;
          for (const directory of libraries) {
            try {
              const path = join(directory, name), bytes = await trustedFile(path);
              queue.push({ path: path.slice(1), bytes }); found = true; break;
            } catch (error) { if (error?.code !== 'ENOENT') throw error; }
          }
          if (!found) throw new Error('RUNTIME_LIBRARY_UNAVAILABLE');
        }
      }
      await add('usr/lib/misaka/smoke.mjs', smoke);
      manifest.files.sort((a, b) => a.path.localeCompare(b.path));
      // Build-user ownership is allowed here, not at runtime. Packaging must
      // install the bundle root-owned and non-group/other-writable; the app must
      // run as a non-root UID. Artifact availability is not native qualification.
      manifest.available = true;
    } catch (error) {
      manifest.reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SANDBOX_BUILD_FAILED';
      manifest.available = false;
      console.warn(`Local sandbox unavailable: ${manifest.reason}. No host fallback.`);
    }
    // The adapter is trusted application code, not part of the replaceable data
    // bundle. A manifest alone must NEVER select an executable to run on host.
    const emitted = join(dist, 'src/ai/local-sandbox.js');
    let adapter;
    try {
      await safeDirectory(dirname(emitted));
      adapter = (await trustedFile(emitted, 1024 * 1024)).toString('utf8');
      pinSandboxAdapter(adapter, 'UNAVAILABLE:BUILD_PENDING', policyHash);
    } catch {
      if (manifest.available) manifest.reason = 'COMPILED_ADAPTER_IDENTITY_MISSING';
      manifest.available = false; adapter = undefined;
      console.warn('Local sandbox unavailable: COMPILED_ADAPTER_IDENTITY_MISSING. Build TypeScript first.');
    }
    const manifestBytes = `${JSON.stringify(manifest)}\n`;
    await writeFile(join(stage, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o444 });
    if (adapter !== undefined) {
      const identity = manifest.available ? `${manifest.binarySha256}:${createHash('sha256').update(manifestBytes).digest('hex')}` : `UNAVAILABLE:${manifest.reason}`;
      const pinned = pinSandboxAdapter(adapter, identity, policyHash);
      const fd = await open(emitted, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_TRUNC);
      try { await fd.writeFile(pinned); } finally { await fd.close(); }
    }
    await chmod(stage, 0o755);
    try { await safeDirectory(output); await rm(output, { recursive: true }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(stage, output); published = true;
    if (requireAvailable && !manifest.available) process.exitCode = 2;
    console.log(`Sandbox build manifest: ${resolve(output, 'manifest.json')}`);
  } finally { if (!published) await rm(stage, { recursive: true, force: true }); }
}
