import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { inputJsonSchema } from '../shared/schemas/index.js';
import {
  parseSubconvCustomParams, subconvBooleanFields, subconvCustomParamsSchema, subconvDefaults, subconvGenerateInputSchema,
  subconvOptionsSchema, subconvPresets, subconvResultSchema, subconvSettingsSchema, subconvSnapshotSchema, subconvSourceCount,
  subconvSourceSchema, subconvTargets, subconvTriStateFields, type SubconvCustomParam, type SubconvOptions,
} from '../shared/schemas/subconv.js';
import { createInvocation, type ActionDefinition, type InvocationContext } from '../src/actions.js';
import { registerSubconvActions, subconvMetadata, SubconvService } from '../src/modules/subconv.js';
import { JSON_DOCUMENT_MAX_BYTES, JsonStorage, type StorageOptions } from '../src/storage.js';
import { coreFixture, invocation } from './support/core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = 'https://source.example/sub?token=TEST_ONLY_SOURCE';
const backend = 'https://converter.example/sub';
const owner = () => invocation({ actorId: 10, chat: { id: 10, type: 'private' } });
const other = () => invocation({ actorId: 11, chat: { id: 11, type: 'private' } });
async function fixture(storageOptions: StorageOptions = {}, contents?: string) {
  const directory = await mkdtemp('/tmp/kilo/misaka-subconv-');
  const storage = new JsonStorage(directory, storageOptions);
  cleanup.push(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  await storage.initialize();
  if (contents !== undefined) await writeFile(join(directory, 'subconv.json'), contents);
  const service = new SubconvService(storage);
  cleanup.push(async () => service.stop());
  if (contents === undefined) await service.initialize();
  return { directory, storage, service };
}
async function configured(options: Partial<SubconvOptions> = {}, endpoint = backend) {
  const f = await fixture();
  await f.service.update(owner(), { backend: endpoint, options: { ...subconvDefaults().options, ...options } }, 0);
  return { ...f, generate: (customParams: SubconvCustomParam[] = [], value = source) => f.service.generate(owner(), { revision: 1, source: value, customParams }) };
}

describe('subconv public contracts', () => {
  it.each(['upload', 'upload_path', 'Upload', 'UPLOAD_PATH'])('excludes publishing control %s from defaults and advanced inputs', async name => {
    expect(subconvCustomParamsSchema.safeParse([{ name, value: 'true' }]).success).toBe(false);
    expect(() => parseSubconvCustomParams(`${name}=true`)).toThrow('INVALID_INPUT');
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: `${backend}?${name}=true` }).success).toBe(false);
    const f = await configured();
    expect(() => f.generate([{ name, value: 'true' }])).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(new URL(f.generate().url).searchParams.has(name)).toBe(false);
  });
  it('rejects encoded or duplicate publication keys in a configured backend', () => {
    for (const query of ['%75pload=true', 'upload%5fpath=config', 'upload=false&upload=true', 'auth=allowed&upload_path=result']) {
      expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: `${backend}?${query}` }).success).toBe(false);
    }
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: `${backend}?auth=allowed` }).success).toBe(true);
  });

  it('exports exactly the six targets, seven presets, field lists and fresh fork defaults', () => {
    expect(subconvTargets).toEqual([
      { id: 'clash', label: 'Clash / Mihomo' }, { id: 'singbox', label: 'sing-box' }, { id: 'surge', label: 'Surge' },
      { id: 'quanx', label: 'Quantumult X' }, { id: 'loon', label: 'Loon' }, { id: 'surfboard', label: 'Surfboard' },
    ]);
    expect(subconvPresets.map(p => [p.id, p.label, p.group, new URL(p.url).pathname.split('/').at(-1)])).toEqual([
      ['basic', 'BASIC', 'universal', 'Basic.ini'], ['misaka', 'Misaka', 'customized', 'Custom.ini'],
      ['yx-full', 'YX-ADFull', 'customized', 'YX-ADFull.ini'], ['ynd', 'YND', 'customized', 'DYNSS.ini'],
      ['adlite', 'ADLite', 'extra', 'ADLite.ini'], ['yx-lite', 'YX-ADLite', 'extra', 'YX-ADLite.ini'], ['ddj', 'DDJ', 'extra', 'DGJ.ini'],
    ]);
    expect(subconvBooleanFields).toEqual(['emoji', 'nodeList', 'scv', 'expand', 'sort', 'appendType', 'insert', 'newName', 'surgeDoh', 'clashDoh']);
    expect(subconvTriStateFields).toEqual(['udp', 'tfo']);
    const defaults = subconvDefaults();
    expect(defaults).toEqual({ backend: '', options: { target: 'clash', remoteConfig: subconvPresets[0].url,
      include: '', exclude: '', filename: '', insert: false, emoji: true, nodeList: false, scv: true, expand: false,
      sort: false, udp: null, tfo: null, appendType: false, newName: true, surgeDoh: false, clashDoh: false } });
    defaults.options.emoji = false;
    expect(subconvDefaults().options.emoji).toBe(true);
    expect(subconvMetadata).toEqual({ id: 'subconv', nameKey: 'web:subconv.name', descriptionKey: 'web:subconv.description', schema_version: 1, configurable: false });
  });
  it('exports strict representable schemas without example URLs, defaults or actor parameters', () => {
    for (const schema of [subconvOptionsSchema, subconvSettingsSchema, subconvSnapshotSchema, subconvGenerateInputSchema, subconvResultSchema]) {
      const json = inputJsonSchema(schema);
      expect(json.additionalProperties).toBe(false);
      expect(JSON.stringify(json)).not.toMatch(/https:\/\/|TEST_ONLY|"default"|"examples"|actorId/);
      expect(() => z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'throw' })).not.toThrow();
    }
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), source }).success).toBe(false);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, udp: 'true' }).success).toBe(false);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, emoji: 1 }).success).toBe(false);
    expect(subconvGenerateInputSchema.safeParse({ revision: '0', source, customParams: [] }).success).toBe(false);
    expect(subconvGenerateInputSchema.safeParse({ revision: 0, source, customParams: [], actorId: 11 }).success).toBe(false);
    expect(subconvGenerateInputSchema.safeParse({ revision: 0, source }).success).toBe(false);
    const polluted: unknown = JSON.parse('{"revision":0,"source":"ss://example","customParams":[],"__proto__":{"polluted":true}}');
    expect(subconvGenerateInputSchema.safeParse(polluted).success).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('parses custom lines at the first equals without trimming values or collapsing duplicates', () => {
    expect(parseSubconvCustomParams(' \r\n\n')).toEqual([]);
    expect(parseSubconvCustomParams(' name = leading = trailing \r\nempty=\rdup=a\ndup=\n\n')).toEqual([
      { name: 'name', value: ' leading = trailing ' }, { name: 'empty', value: '' }, { name: 'dup', value: 'a' }, { name: 'dup', value: '' },
    ]);
    expect(parseSubconvCustomParams('p=\t value\t')).toEqual([{ name: 'p', value: '\t value\t' }]);
    for (const value of ['no_equals', '=value', '__proto__=x', 'bad name=x', 'x[]=y', `${'x'.repeat(65)}=y`]) {
      expect(() => parseSubconvCustomParams(value)).toThrow('INVALID_INPUT');
    }
    expect(() => parseSubconvCustomParams(Array.from({ length: 17 }, () => 'x=').join('\n'))).toThrow('INVALID_INPUT');
    expect(subconvCustomParamsSchema.safeParse([{ name: 'x', value: '', extra: true }]).success).toBe(false);
    expect(subconvCustomParamsSchema.safeParse([{ name: 'x', value: null }]).success).toBe(false);
  });
  it('enforces source, text, per-custom and aggregate character boundaries', () => {
    const exact = `https://source.example/${'x'.repeat(8192 - 'https://source.example/'.length)}`;
    expect(subconvSourceSchema.safeParse(exact).success).toBe(true);
    expect(subconvSourceSchema.safeParse(`${exact}x`).success).toBe(false);
    expect(subconvSourceCount(' |\r\n https://one.example/ | \nss://two\r\n||')).toBe(2);
    expect(subconvSourceSchema.safeParse(Array.from({ length: 16 }, () => 'ss://example').join('|')).success).toBe(true);
    expect(subconvSourceSchema.safeParse(Array.from({ length: 17 }, () => 'ss://example').join('|')).success).toBe(false);
    for (const [field, length] of [['include', 512], ['exclude', 512], ['filename', 128]] as const) {
      expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, [field]: 'x'.repeat(length) }).success).toBe(true);
      expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, [field]: 'x'.repeat(length + 1) }).success).toBe(false);
    }
    const endpoint = `https://example/${'x'.repeat(2048 - 'https://example/'.length)}`;
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: endpoint }).success).toBe(true);
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: `${endpoint}x` }).success).toBe(false);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, remoteConfig: endpoint }).success).toBe(true);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, remoteConfig: `${endpoint}x` }).success).toBe(false);
    expect(subconvCustomParamsSchema.safeParse([{ name: 'x', value: 'x'.repeat(2048) }]).success).toBe(true);
    expect(subconvCustomParamsSchema.safeParse([{ name: 'x', value: 'x'.repeat(2049) }]).success).toBe(false);
    expect(subconvCustomParamsSchema.safeParse([{ name: 'x', value: '\u{1f600}'.repeat(1024) }]).success).toBe(true);
    expect(subconvCustomParamsSchema.safeParse([{ name: 'x', value: '\u{1f600}'.repeat(1025) }]).success).toBe(false);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, filename: '\u{1f600}'.repeat(64) }).success).toBe(true);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, filename: '\u{1f600}'.repeat(65) }).success).toBe(false);
    const aggregate = Array.from({ length: 4 }, () => ({ name: 'x', value: 'x'.repeat(2047) }));
    expect(subconvCustomParamsSchema.safeParse(aggregate).success).toBe(true);
    aggregate[0]!.value += 'x';
    expect(subconvCustomParamsSchema.safeParse(aggregate).success).toBe(false);
  });
});

describe('pure fork-compatible URL generation', () => {
  it('matches the exact clean default query without forced transport or expanded rules', async () => {
    const f = await configured();
    const result = f.generate();
    expect([...new URL(result.url).searchParams]).toEqual([
      ['target', 'clash'], ['url', source], ['insert', 'false'], ['config', subconvPresets[0].url],
      ['emoji', 'true'], ['scv', 'true'], ['expand', 'false'],
    ]);
    expect(result).toEqual({ url: result.url, sourceCount: 1, target: 'clash', backendHost: 'converter.example', skipsCertVerification: true });
  });
  it.each(subconvTargets)('serializes $id and emits Surge version as a separate parameter', async ({ id }) => {
    const f = await configured({ target: id, surgeDoh: true, clashDoh: true, expand: true });
    const query = new URL(f.generate().url).searchParams;
    expect(query.get('target')).toBe(id);
    expect(query.get('ver')).toBe(id === 'surge' ? '4' : null);
    expect(query.get('surge.doh')).toBe('true');
    expect(query.get('clash.doh')).toBe(id === 'clash' ? 'true' : null);
    expect(query.get('new_name')).toBe(id === 'clash' ? 'true' : null);
  });
  it.each([null, true, false])('preserves UDP and TFO tristate %s', async value => {
    const f = await configured({ udp: value, tfo: value });
    const params = new URL(f.generate().url).searchParams;
    expect(params.get('udp')).toBe(value === null ? null : String(value));
    expect(params.get('tfo')).toBe(value === null ? null : String(value));
  });
  it('keeps literal Unicode, regexes, source whitespace, percent escapes, plus and fragment text', async () => {
    const literal = '\u8282\u70b9 #1 & A+$';
    const f = await configured({ include: '(\u9999\u6e2f|\u65e5\u672c)$', exclude: 'a & b+%20', filename: literal,
      remoteConfig: 'https://config.example/test?token=a+b&literal=%20', appendType: true, nodeList: true, sort: true });
    const raw = ' https://source.example/A?a=1&b=a+b%20#literal \r\nss://example#\u65e5\u672c \r\n\n';
    const result = f.generate([{ name: 'extra', value: literal }, { name: 'replacement', value: '$1 & $&' }], raw);
    const params = new URL(result.url).searchParams;
    expect(params.get('url')).toBe(raw.replace(/\r\n|\r|\n/g, '|'));
    expect(params.get('config')).toBe('https://config.example/test?token=a+b&literal=%20');
    expect(params.get('include')).toBe('(\u9999\u6e2f|\u65e5\u672c)$');
    expect(params.get('exclude')).toBe('a & b+%20');
    expect(params.get('filename')).toBe(literal);
    expect(params.get('extra')).toBe(literal);
    expect(params.get('replacement')).toBe('$1 & $&');
    expect(params.get('append_type')).toBe('true');
    expect(params.get('list')).toBe('true');
    expect(params.get('sort')).toBe('true');
    expect(result.sourceCount).toBe(2);
    expect(result.url).toContain('%2520');
    expect(result.url).toMatch(/^[\x21-\x7e]+$/);
    expect(Buffer.byteLength(result.url)).toBe(result.url.length);
  });
  it('applies ordered custom overrides once, preserving empty values and safe object-like names', async () => {
    const f = await configured({}, `${backend}?token=old&token=older`);
    const result = f.generate([
      { name: 'target', value: 'surge' }, { name: 'ver', value: '3' }, { name: 'token', value: 'new' },
      { name: 'extra', value: 'first' }, { name: 'extra', value: '' }, { name: 'config', value: '' },
      { name: 'constructor', value: 'literal' }, { name: 'prototype', value: 'safe' }, { name: 'scv', value: 'false' },
      { name: 'url', value: 'ss://one|ss://two' },
    ]);
    const params = new URL(result.url).searchParams;
    expect(params.getAll('token')).toEqual(['new']);
    expect(params.getAll('extra')).toEqual(['']);
    expect(params.get('config')).toBe('');
    expect(params.get('new_name')).toBe('true');
    expect(params.get('constructor')).toBe('literal');
    expect(params.get('prototype')).toBe('safe');
    expect(params.get('ver')).toBe('3');
    expect(result).toMatchObject({ target: 'surge', skipsCertVerification: false, sourceCount: 2 });
    expect(new URL(f.generate([{ name: 'target', value: 'surge' }]).url).searchParams.has('ver')).toBe(false);
    expect(f.generate([{ name: 'target', value: '' }]).target).toBe('');
  });
  it('preserves arbitrary custom value characters and applies source validation after overrides', async () => {
    const f = await configured();
    const literal = '\t space\0\u202e \t';
    const multiline = 'ss://one\r\nss://two';
    const result = f.generate([{ name: 'literal', value: literal }, { name: 'url', value: multiline }]);
    const params = new URL(result.url).searchParams;
    expect(params.get('literal')).toBe(literal);
    expect(params.get('url')).toBe(multiline);
    expect(result.sourceCount).toBe(2);
    expect(result.url).toMatch(/^[\x21-\x7e]+$/);
    expect(() => f.generate([{ name: 'url', value: 'ss://one\t' }])).toThrow('INVALID_INPUT');
    expect(() => f.generate([{ name: 'config', value: 'https://example/\u202e' }])).toThrow('INVALID_INPUT');
  });
  it('prunes only implicit exact false defaults and honors selected and final targets', async () => {
    const f = await configured({}, `${backend}?list=true&sort=true&new_name=false&udp=true&tfo=false&ver=3&extra=a&extra=b`);
    const defaults = new URL(f.generate().url).searchParams;
    for (const key of ['list', 'sort', 'new_name']) expect(defaults.has(key)).toBe(false);
    expect(defaults.get('udp')).toBe('true');
    expect(defaults.get('tfo')).toBe('false');
    expect(defaults.get('ver')).toBe('3');
    expect(defaults.getAll('extra')).toEqual(['a', 'b']);
    const custom = new URL(f.generate([{ name: 'list', value: 'false' }, { name: 'sort', value: 'false' }, { name: 'new_name', value: 'true' }]).url).searchParams;
    expect(custom.get('list')).toBe('false'); expect(custom.get('sort')).toBe('false'); expect(custom.get('new_name')).toBe('true');
    for (const value of ['false', '0', 'true', '1', '2', '01', 'FALSE', ' false', '0 ', '-1', '', '2suffix']) {
      const result = f.generate([{ name: 'expand', value }, { name: 'scv', value }]);
      expect(new URL(result.url).searchParams.has('new_name')).toBe(!['false', '0'].includes(value));
      expect(result.skipsCertVerification).toBe(['false', '0'].includes(value) ? false : ['true', '1', '2', '2suffix'].includes(value) ? true : null);
    }
    const selectedSurge = await configured({ target: 'surge' }, `${backend}?new_name=true`);
    const changed = new URL(selectedSurge.generate([{ name: 'target', value: 'clash' }]).url).searchParams;
    expect(changed.get('new_name')).toBe('true'); expect(changed.get('ver')).toBe('4');
    const legacy = await configured({ newName: false });
    expect(new URL(legacy.generate().url).searchParams.get('new_name')).toBe('false');
  });
  it.each(['', '/', '/prefix', '/prefix/', '/sub', '/sub/', '/prefix/sub', '/prefix/sub/'])('normalizes endpoint path %s without dropping prefix or querying the network', async path => {
    const fetch = vi.fn(() => { throw new Error('No requests allowed'); });
    vi.stubGlobal('fetch', fetch);
    const f = await configured({}, `http://127.0.0.1:25500${path}?auth=TEST_ONLY_ROUTING`);
    const result = f.generate();
    const endpoint = new URL(result.url);
    expect(endpoint.pathname).toBe(path.includes('prefix') ? '/prefix/sub' : '/sub');
    expect(endpoint.searchParams.get('auth')).toBe('TEST_ONLY_ROUTING');
    expect(result.backendHost).toBe('127.0.0.1:25500');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('permits private IPv6, localhost, empty config and inherited routing options', async () => {
    for (const host of ['[::1]:25500', 'localhost:25500', '10.0.0.1:1234']) {
      const f = await configured({ remoteConfig: '' }, `http://${host}/prefix?route=/nested&append_type=true`);
      const result = f.generate();
      expect(result.backendHost).toBe(host);
      expect(new URL(result.url).searchParams.has('config')).toBe(false);
      expect(new URL(result.url).searchParams.get('append_type')).toBe('true');
    }
    const httpsAt80 = await configured({}, 'https://localhost:80/sub');
    expect(httpsAt80.generate().backendHost).toBe('localhost:80');
    const httpAt443 = await configured({}, 'http://localhost:443/sub');
    expect(httpAt443.generate().backendHost).toBe('localhost:443');
  });
  it('requires an explicit backend and never falls back to a public or local converter', async () => {
    const f = await fixture();
    expect(f.service.settings(owner()).settings.backend).toBe('');
    expect(() => f.service.generate(owner(), { revision: 0, source, customParams: [] })).toThrow('INVALID_INPUT');
    expect(() => f.service.generate(owner(), { revision: 0, source, customParams: [] })).toThrow(expect.objectContaining({ fields: ['backend'] }));
  });
});

describe('subconv URL validation and encoded size budget', () => {
  it.each(['file:///etc/config', '/etc/config', '../config.ini', 'C:\\config.ini', 'ftp://example/sub', 'javascript:alert(1)', 'data:text/plain,config',
    'https://user:pass@example/sub', 'https://@example/sub', 'https://example/#fragment', 'https://example/#', 'https://example/\nsub',
    'https://example/\u202esub', ' https://example/', 'https:\\example\\sub', 'https://'])('rejects unsafe backend/config input %j', value => {
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: value }).success).toBe(false);
    expect(subconvOptionsSchema.safeParse({ ...subconvDefaults().options, remoteConfig: value }).success).toBe(false);
  });
  it.each(['target=clash', 'url=ss%3A%2F%2Fexample', '%74arget=', '%75rl=', 'token=x&url='])('rejects pasted generated backend query %s', query => {
    expect(subconvSettingsSchema.safeParse({ ...subconvDefaults(), backend: `${backend}?${query}` }).success).toBe(false);
  });
  it.each(['', '  |\n', 'file:///etc/passwd', '/root/config', './config', 'C:\\config', 'aHR0cHM6Ly9leGFtcGxlLw==',
    'javascript:alert(1)', 'ftp://example/', 'https://', 'https:example', '//example/sub', 'ss://', 'data:text/plain,', 'ss://example\0',
    'https://example/\t', 'ss://example\u202e', 'https://example/\ud800', 'ss://valid|/etc/passwd'])('rejects invalid or unsafe source %j', value => {
    expect(subconvSourceSchema.safeParse(value).success).toBe(false);
  });
  it.each(['http://localhost:1234/sub', 'https://example/sub#literal', 'ss://example', 'ssr://example', 'ssd://example', 'vmess://eyJ0ZXN0Ijp0cnVlfQ==',
    'vless://id@example:443#name', 'trojan://password@example:443#name', 'hysteria2://test@example:443', 'tuic://test@example:443',
    'socks5://test@example:1080', 'wireguard://test@example:51820', 'anytls://test@example:443', 'data:text/plain;base64,c3M6Ly9leGFtcGxl'])('accepts a literal URL or common node/data share %s without fetching or decoding', value => {
    expect(subconvSourceSchema.parse(value)).toBe(value);
  });
  it('validates final url/config custom overrides and inherited configs, not discarded intermediate values', async () => {
    const f = await configured();
    for (const [name, value] of [['url', '/etc/passwd'], ['url', ''], ['url', 'javascript:alert(1)'], ['config', '/etc/config'], ['config', 'https://user:pass@example/']] as const) {
      expect(() => f.generate([{ name, value }])).toThrow('INVALID_INPUT');
      expect(() => f.generate([{ name, value }, { name, value: name === 'url' ? 'ss://example' : '' }])).not.toThrow();
    }
    const inherited = await configured({ remoteConfig: '' }, `${backend}?config=%2Fetc%2Fconfig`);
    expect(() => inherited.generate()).toThrow('INVALID_INPUT');
    expect(() => inherited.generate([{ name: 'config', value: 'http://localhost:1234/config.ini' }])).not.toThrow();
    const duplicate = await configured({ remoteConfig: '' }, `${backend}?config=https%3A%2F%2Fconfig.example%2F&config=%2Fetc%2Fconfig`);
    expect(() => duplicate.generate()).toThrow('INVALID_INPUT');
  });
  it('enforces the final 24576 ASCII-byte boundary after encoding and all overrides', async () => {
    const f = await configured();
    const value = 'data:text/plain,';
    const custom = [{ name: 'pad', value: '' }];
    const base = f.generate(custom, value + 'a').url.length - 1;
    const extra = 24_576 - base;
    const unicode = Math.floor(extra / 9);
    const remainder = extra % 9;
    const exact = value + '\u754c'.repeat(unicode) + 'a'.repeat(remainder);
    const result = f.generate(custom, exact);
    expect(result.url.length).toBe(24_576);
    expect(Buffer.byteLength(result.url)).toBe(24_576);
    expect(subconvResultSchema.safeParse(result).success).toBe(true);
    expect(() => f.generate(custom, `${exact}a`)).toThrow('INVALID_INPUT');
    expect(subconvResultSchema.safeParse({ ...result, url: `${result.url}a` }).success).toBe(false);
    expect(() => f.generate([{ name: 'extra', value: '\u754c'.repeat(2048) }], `data:text/plain,${'\u754c'.repeat(1000)}`)).toThrow('INVALID_INPUT');
  });
});

describe('personal subconv storage and private Actions', () => {
  it('keeps personal revisions independent, commits atomically, restores only options and persists no one-shot data', async () => {
    const observed: string[] = [];
    let directory = '';
    const f = await fixture({ beforeCommit: async filename => {
      if (directory && filename === 'subconv.json') observed.push(await readFile(join(directory, filename), 'utf8'));
    } });
    directory = f.directory;
    const initial = await readFile(join(directory, 'subconv.json'), 'utf8');
    const settings = { backend: `${backend}?token=TEST_ONLY_BACKEND`, options: { ...subconvDefaults().options, emoji: false } };
    expect(await f.service.update(owner(), settings, 0)).toEqual({ revision: 1, settings });
    expect(observed).toEqual([initial]);
    expect(f.service.settings(other())).toEqual({ revision: 0, settings: subconvDefaults() });
    await f.service.update(other(), { ...subconvDefaults(), backend: 'http://localhost:25500' }, 0);
    const beforeGeneration = await readFile(join(directory, 'subconv.json'), 'utf8');
    const result = f.service.generate(owner(), { revision: 1, source, customParams: [{ name: 'once', value: 'TEST_ONLY_CUSTOM' }] });
    expect(await readFile(join(directory, 'subconv.json'), 'utf8')).toBe(beforeGeneration);
    expect(beforeGeneration).not.toContain('TEST_ONLY_SOURCE'); expect(beforeGeneration).not.toContain('TEST_ONLY_CUSTOM'); expect(beforeGeneration).not.toContain(result.url);
    const returned = f.service.settings(owner()); returned.settings.backend = 'https://changed.example';
    expect(f.service.settings(owner()).settings.backend).toBe(settings.backend);
    expect(await f.service.reset(owner(), 1)).toEqual({ revision: 2, settings: { ...subconvDefaults(), backend: settings.backend } });
    expect(f.service.settings(other()).revision).toBe(1);
    const restored = new SubconvService(f.storage); await restored.initialize();
    expect(restored.settings(owner())).toEqual(f.service.settings(owner()));
    expect((JSON.parse(await readFile(join(directory, 'subconv.json'), 'utf8')) as { revision: number }).revision).toBe(3);
    expect((await stat(join(directory, 'subconv.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['subconv.json']);
  });
  it('rejects stale generation/update/reset and serializes concurrent personal writes through the shared mutex', async () => {
    const f = await configured();
    const options = { ...subconvDefaults(), backend };
    const writes = await Promise.allSettled([f.service.update(owner(), options, 1), f.service.update(owner(), options, 1)]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
    expect(() => f.generate()).toThrow('CONFLICT');
    await expect(f.service.reset(owner(), 1)).rejects.toThrow('CONFLICT');
    expect(f.service.settings(owner()).revision).toBe(2);
  });
  it('preserves committed bytes and snapshots when a write fails or is cancelled before rename', async () => {
    let fail = false;
    const controller = new AbortController();
    const f = await fixture({ beforeCommit: async () => { if (fail) throw new Error('TEST_ONLY_INTERNAL_PATH'); } });
    const initial = await readFile(join(f.directory, 'subconv.json'), 'utf8');
    fail = true;
    await expect(f.service.update(owner(), { ...subconvDefaults(), backend }, 0)).rejects.toThrow('STORAGE_ERROR');
    expect(f.service.settings(owner()).revision).toBe(0);
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).toBe(initial);
    expect(await readdir(f.directory)).toEqual(['subconv.json']);
    fail = false;
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    f.storage.options.beforeCommit = async () => { entered.resolve(); await release.promise; };
    const pending = f.service.update(createInvocation({ ...owner(), signal: controller.signal }), { ...subconvDefaults(), backend }, 0);
    await entered.promise; controller.abort(); release.resolve();
    await expect(pending).rejects.toThrow('CANCELLED');
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).toBe(initial);
    expect(f.service.settings(owner()).revision).toBe(0);
  });
  it.each(['{"schema_version":2,"revision":0,"users":{}}', '{broken', '{"schema_version":1,"revision":0,"users":{"__proto__":{}}}',
    '{"schema_version":1,"revision":0,"users":{"10":{"revision":0,"settings":{}}}}'])('fails loading corrupt or unknown state without changing original bytes', async bytes => {
    const f = await fixture({}, bytes);
    await expect(f.service.initialize()).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).toBe(bytes);
    expect(await readdir(f.directory)).toEqual(['subconv.json']);
  });
  it('returns CAPACITY before an oversized candidate commit and preserves the existing document', async () => {
    const settings = subconvDefaults();
    settings.options.include = '\u754c'.repeat(512);
    const users: Record<string, { revision: number; settings: ReturnType<typeof subconvDefaults> }> = {};
    const sample = Buffer.byteLength(JSON.stringify({ revision: 0, settings }, null, 2));
    const count = Math.floor(JSON_DOCUMENT_MAX_BYTES / (sample + 140));
    for (let index = 1; index <= count; index++) users[String(index)] = { revision: 0, settings };
    const state = { schema_version: 1, revision: 0, users };
    let bytes = `${JSON.stringify(state, null, 2)}\n`;
    while (Buffer.byteLength(bytes) > JSON_DOCUMENT_MAX_BYTES - 2000) {
      delete users[Object.keys(users).at(-1)!]; bytes = `${JSON.stringify(state, null, 2)}\n`;
    }
    while (Buffer.byteLength(bytes) < JSON_DOCUMENT_MAX_BYTES - 2000) {
      const id = String(Object.keys(users).length + 1); users[id] = { revision: 0, settings };
      const candidate = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(candidate) > JSON_DOCUMENT_MAX_BYTES - 2000) { delete users[id]; break; }
      bytes = candidate;
    }
    const commit = vi.fn(async () => {});
    const f = await fixture({ beforeCommit: commit }, bytes); await f.service.initialize();
    const large = { backend: `https://example/${'x'.repeat(2000)}`, options: { ...settings.options,
      remoteConfig: `https://config.example/${'x'.repeat(2000)}`, exclude: '\u754c'.repeat(512) } };
    await expect(f.service.update(owner(), large, 0)).rejects.toThrow('CAPACITY');
    expect(commit).not.toHaveBeenCalled();
    expect(f.service.settings(owner()).revision).toBe(0);
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).toBe(bytes);
  });
  it('limits new personal records to 10000 users without evicting stored preferences', async () => {
    const users = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [String(index + 1), { revision: 0, settings: subconvDefaults() }]));
    const bytes = JSON.stringify({ schema_version: 1, revision: 0, users });
    const commit = vi.fn(async () => {});
    const f = await fixture({ beforeCommit: commit }, bytes); await f.service.initialize();
    const next = invocation({ actorId: 10_001, chat: { id: 10_001, type: 'private' } });
    await expect(f.service.update(next, subconvDefaults(), 0)).rejects.toThrow('CAPACITY');
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).toBe(bytes);
  });
  it('rejects exhausted personal revisions without issuing a write', async () => {
    const bytes = JSON.stringify({ schema_version: 1, revision: 1, users: { '10': { revision: Number.MAX_SAFE_INTEGER, settings: subconvDefaults() } } });
    const commit = vi.fn(async () => {});
    const f = await fixture({ beforeCommit: commit }, bytes); await f.service.initialize();
    await expect(f.service.reset(owner(), Number.MAX_SAFE_INTEGER)).rejects.toThrow('CAPACITY');
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).toBe(bytes);
  });
  it('registers private self-only Actions with model-safe projections while raw subconv remains Telegram-only', () => {
    const definitions: ActionDefinition<unknown, unknown>[] = [];
    const service = {} as SubconvService;
    registerSubconvActions({ register: definition => { definitions.push(definition as ActionDefinition<unknown, unknown>); } }, service);
    expect(definitions.map(item => [item.id, item.effect])).toEqual([
      ['subconv.settings.get', 'read'], ['subconv.settings.set', 'personal_write'], ['subconv.settings.reset', 'personal_write'], ['subconv.generate', 'read'],
      ['subconv.options.set', 'personal_write'], ['subconv.sources', 'read'], ['subconv.generate_owned', 'personal_write'],
    ]);
    const visible = ['subconv.settings.get', 'subconv.options.set', 'subconv.sources', 'subconv.generate_owned'];
    for (const definition of definitions) {
      expect(definition).toMatchObject({ permission: 'self', scopes: ['private'],
        sources: visible.includes(definition.id) ? ['telegram', 'ai'] : ['telegram'], aiVisible: visible.includes(definition.id) });
      expect(inputJsonSchema(definition.input)).toMatchObject({ additionalProperties: false });
      if (['subconv.settings.get', 'subconv.options.set'].includes(definition.id)) {
        expect(definition.aiOutput).toBeDefined();
        expect(definition.modelOutput).toEqual(expect.any(Function));
      }
    }
  });
  it('enforces ownership through Actions and never puts secret URL values in audit, errors or schemas', async () => {
    const f = await coreFixture({ services: { aiEnabled: true } }); cleanup.push(f.close);
    const settings = { ...subconvDefaults(), backend: `${backend}?token=TEST_ONLY_BACKEND` };
    const saved = await f.executor.execute(owner(), 'subconv.settings.set', { revision: 0, settings });
    expect(saved).toMatchObject({ status: 'succeeded', data: { revision: 1 } });
    expect(await f.executor.execute(other(), 'subconv.settings.get', {})).toMatchObject({ status: 'succeeded', data: { revision: 0, settings: subconvDefaults() } });
    const result = await f.executor.execute(owner(), 'subconv.generate', { revision: 1, source, customParams: [{ name: 'test', value: 'TEST_ONLY_CUSTOM' }] });
    expect(result).toMatchObject({ status: 'succeeded', data: { target: 'clash', sourceCount: 1 } });
    const model = invocation({ actorId: 10, chat: { id: 10, type: 'private' }, aiRunId: 'subconv-run' });
    const projected = await f.executor.executeTool(model, 'subconv.settings.get', {});
    expect(projected).toMatchObject({ status: 'succeeded', data: { revision: 1, configured: true, target: 'clash' } });
    expect(JSON.stringify(projected)).not.toMatch(/TEST_ONLY|backend|https:\/\/|include|exclude/);
    for (const [id, input] of [['subconv.settings.set', { revision: 1, settings }], ['subconv.settings.reset', { revision: 1 }]] as const) {
      expect(await f.executor.executeTool(model, id, input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    }
    for (const context of [invocation({ source: 'http' }), invocation({ source: 'ai' }), invocation({ chat: { id: -100, type: 'supergroup' } }), { ...owner() } as InvocationContext]) {
      const rejected = await f.executor.execute(context, 'subconv.generate', { revision: 1, source, customParams: [] });
      expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
      expect(JSON.stringify(rejected)).not.toContain('TEST_ONLY');
    }
    const invalids = [
      await f.executor.execute(owner(), 'subconv.generate', { revision: 1, source: 'TEST_ONLY_INVALID_SOURCE', customParams: [] }),
      await f.executor.execute(owner(), 'subconv.generate', { revision: 1, source, customParams: [{ name: 'url', value: 'TEST_ONLY_OVERRIDE' }] }),
      await f.executor.execute(owner(), 'subconv.settings.set', { revision: 1, settings: { ...settings, backend: 'TEST_ONLY_INVALID_BACKEND' } }),
      await f.executor.execute(owner(), 'subconv.settings.set', { revision: 1, settings, 'https://TEST_ONLY_UNKNOWN': true }),
    ];
    for (const invalid of invalids) { expect(invalid).toMatchObject({ error: { code: 'INVALID_INPUT' } }); expect(JSON.stringify(invalid)).not.toContain('TEST_ONLY'); }
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('TEST_ONLY');
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('https://');
    expect(JSON.stringify(inputJsonSchema(subconvSettingsSchema))).not.toContain('TEST_ONLY');
    expect(f.subconv.settings(owner()).revision).toBe(1);
    await expect(f.subconv.update(owner(), { ...settings, backend: 'TEST_ONLY_INVALID_BACKEND' }, 1)).rejects.toThrow('INVALID_INPUT');
    expect(() => f.subconv.settings(invocation({ source: 'http' }))).toThrow('FORBIDDEN');
    expect(() => f.subconv.settings(invocation({ chat: { id: -100, type: 'supergroup' } }))).toThrow('FORBIDDEN');
  });
});
