import { z } from 'zod';
import { revisionSchema } from './index.js';

export const subconvTargets = [
  { id: 'clash', label: 'Clash / Mihomo' }, { id: 'singbox', label: 'sing-box' },
  { id: 'surge', label: 'Surge' }, { id: 'quanx', label: 'Quantumult X' },
  { id: 'loon', label: 'Loon' }, { id: 'surfboard', label: 'Surfboard' },
] as const;
const gist = 'https://gist.githubusercontent.com/Misakamoe/f9eb77a91fd1a582cedf13e362123cf6/raw/';
const yx = 'https://raw.githubusercontent.com/Yixie2020/clashrule/master/';
export const subconvPresets = [
  { id: 'basic', label: 'BASIC', group: 'universal', url: `${gist}Basic.ini` },
  { id: 'misaka', label: 'Misaka', group: 'customized', url: `${gist}Custom.ini` },
  { id: 'yx-full', label: 'YX-ADFull', group: 'customized', url: `${yx}YX-ADFull.ini` },
  { id: 'ynd', label: 'YND', group: 'customized', url: `${gist}DYNSS.ini` },
  { id: 'adlite', label: 'ADLite', group: 'extra', url: `${gist}ADLite.ini` },
  { id: 'yx-lite', label: 'YX-ADLite', group: 'extra', url: `${yx}YX-ADLite.ini` },
  { id: 'ddj', label: 'DDJ', group: 'extra', url: `${gist}DGJ.ini` },
] as const;
export const subconvBooleanFields = ['emoji', 'nodeList', 'scv', 'expand', 'sort', 'appendType', 'insert', 'newName', 'surgeDoh', 'clashDoh'] as const;
export const subconvTriStateFields = ['udp', 'tfo'] as const;

const unsafeText = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const publicationParameter = /^(?:upload|upload_path)$/i;
const text = (max: number) => z.string().max(max).refine(value => value.length <= max && !unsafeText.test(value), { message: 'INVALID_INPUT' });
function httpUrl(value: string, endpoint = false): boolean {
  if (!value) return true;
  if (value !== value.trim() || !/^https?:\/\//i.test(value) || /[#\\]/.test(value)
    || /^https?:\/\/[^/\s?]*@/i.test(value) || unsafeText.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password && !url.hash
      && (!endpoint || !url.searchParams.has('target') && !url.searchParams.has('url')
        && [...url.searchParams.keys()].every(name => !publicationParameter.test(name)));
  } catch { return false; }
}
const remoteConfigSchema = text(2048).refine(value => httpUrl(value), { message: 'INVALID_INPUT' });
export const subconvOptionsSchema = z.strictObject({
  target: z.enum(['clash', 'singbox', 'surge', 'quanx', 'loon', 'surfboard']),
  remoteConfig: remoteConfigSchema, include: text(512), exclude: text(512), filename: text(128),
  insert: z.boolean(), emoji: z.boolean(), nodeList: z.boolean(), scv: z.boolean(), expand: z.boolean(), sort: z.boolean(),
  udp: z.boolean().nullable(), tfo: z.boolean().nullable(), appendType: z.boolean(), newName: z.boolean(),
  surgeDoh: z.boolean(), clashDoh: z.boolean(),
});
export const subconvSettingsSchema = z.strictObject({
  backend: text(2048).refine(value => httpUrl(value, true), { message: 'INVALID_INPUT' }), options: subconvOptionsSchema,
});
export const subconvSnapshotSchema = z.strictObject({ revision: revisionSchema, settings: subconvSettingsSchema });
const customValueSchema = z.string().max(2048).refine(value => value.length <= 2048, { message: 'INVALID_INPUT' });
export const subconvCustomParamsSchema = z.array(z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/).refine(name => !publicationParameter.test(name), { message: 'INVALID_INPUT' }), value: customValueSchema,
})).max(16).refine(params => params.reduce((sum, item) => sum + item.name.length + item.value.length, 0) <= 8192, { message: 'INVALID_INPUT' });

const nodeProtocols = new Set(['ss:', 'ssr:', 'ssd:', 'vmess:', 'vless:', 'trojan:', 'trojan-go:', 'hysteria:', 'hysteria2:', 'hy2:',
  'tuic:', 'snell:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:', 'wireguard:', 'wg:', 'anytls:', 'mieru:', 'naive+https:', 'juicity:', 'shadowtls:']);
export function subconvSourceCount(source: string): number { return source.split(/[|\r\n]/).filter(piece => piece.trim()).length; }
export const subconvSourceSchema = z.string().min(1).max(8192).refine(source => {
  if (source.length > 8192 || unsafeText.test(source.replace(/\r\n|\r|\n/g, ''))) return false;
  const pieces = source.split(/[|\r\n]/).map(piece => piece.trim()).filter(Boolean);
  if (!pieces.length || pieces.length > 16) return false;
  return pieces.every(piece => {
    try {
      const url = new URL(piece);
      if (url.protocol === 'http:' || url.protocol === 'https:') return /^https?:\/\//i.test(piece) && Boolean(url.hostname) && !piece.includes('\\');
      if (url.protocol === 'data:') return /^data:[^,]*,.+/i.test(piece);
      return nodeProtocols.has(url.protocol) && /^[a-z][a-z0-9+.-]*:\/\/\S+/i.test(piece);
    } catch { return false; }
  });
}, { message: 'INVALID_INPUT' });
export const subconvGenerateInputSchema = z.strictObject({ revision: revisionSchema, source: subconvSourceSchema, customParams: subconvCustomParamsSchema });
export const subconvResultSchema = z.strictObject({
  url: z.string().min(1).max(24_576).regex(/^[\x21-\x7e]+$/).refine(value => httpUrl(value), { message: 'INVALID_OUTPUT' }),
  sourceCount: z.number().int().min(1).max(16), target: customValueSchema,
  backendHost: z.string().min(1).max(2048).refine(value => {
    try { return new URL(`http://${value}`).host === value || new URL(`https://${value}`).host === value; } catch { return false; }
  }, { message: 'INVALID_OUTPUT' }),
  skipsCertVerification: z.boolean().nullable(),
});

export type SubconvOptions = z.infer<typeof subconvOptionsSchema>;
export type SubconvSettings = z.infer<typeof subconvSettingsSchema>;
export type SubconvSnapshot = z.infer<typeof subconvSnapshotSchema>;
export type SubconvCustomParam = z.infer<typeof subconvCustomParamsSchema>[number];
export type SubconvResult = z.infer<typeof subconvResultSchema>;

export function subconvDefaults(): SubconvSettings {
  return { backend: '', options: {
    target: 'clash', remoteConfig: subconvPresets[0].url, include: '', exclude: '', filename: '', insert: false,
    emoji: true, nodeList: false, scv: true, expand: false, sort: false, udp: null, tfo: null, appendType: false,
    newName: true, surgeDoh: false, clashDoh: false,
  } };
}

export function parseSubconvCustomParams(text: string): SubconvCustomParam[] {
  if (typeof text !== 'string') throw new Error('INVALID_INPUT');
  const params: SubconvCustomParam[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    const equals = line.indexOf('=');
    if (equals < 0) throw new Error('INVALID_INPUT');
    params.push({ name: line.slice(0, equals).trim(), value: line.slice(equals + 1) });
    if (params.length > 16) throw new Error('INVALID_INPUT');
  }
  const result = subconvCustomParamsSchema.safeParse(params);
  if (!result.success) throw new Error('INVALID_INPUT');
  return result.data;
}
