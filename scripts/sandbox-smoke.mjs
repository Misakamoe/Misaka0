// Fixed build input, never supplied by a model. Runs only after the C escape and
// resource tests, inside the same mounts, capabilities and syscall allowlist.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import process from 'node:process';
assert.equal(process.versions.node.split('.')[0], '24');
assert.equal(process.cwd(), '/work');
assert.equal(process.env.HOME, '/work');
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(Object.keys(process.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'UV_THREADPOOL_SIZE']);
assert.throws(() => fs.readFileSync('/home/.env'));
assert.throws(() => fs.readFileSync('/proc/1/root/home/.env'));
assert.throws(() => fs.openSync('/proc/1/fd/6', 'w'));
assert.throws(() => fs.writeFileSync('/usr/bin/node', 'x'));
fs.writeFileSync('/work/tmp/smoke', 'isolated');
assert.equal(fs.readFileSync('/work/tmp/smoke', 'utf8'), 'isolated');
