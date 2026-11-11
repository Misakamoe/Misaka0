import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { AccessService } from '../../src/access.js';
import { ActionExecutor, createInvocation, type ActionServices, type InvocationInput } from '../../src/actions.js';
import { ConfigurationService } from '../../src/configuration.js';
import { JsonStorage, type StorageOptions } from '../../src/storage.js';
import { AliasService } from '../../src/modules/alias.js';
import { RssService, type RssOptions } from '../../src/modules/rss.js';
import { RateService, type RateOptions } from '../../src/modules/rate.js';
import { WeatherService, type WeatherOptions } from '../../src/modules/weather.js';
import { StickerService } from '../../src/modules/sticker.js';
import { SubconvService } from '../../src/modules/subconv.js';
import { commands } from '../../src/telegram/commands.js';

export const testToken = `12345:${'A'.repeat(35)}`;
export const environment = { MISAKA_BOT_TOKEN: testToken, MISAKA_ADMIN_IDS: '1,2' };

export function offlineStickers(options: Partial<ConstructorParameters<typeof StickerService>[0]> = {}): StickerService {
  return new StickerService({ ...options,
    transport: options.transport ?? {
      download: vi.fn(async () => { throw new Error('Unexpected sticker download'); }),
      getSet: vi.fn(async () => { throw new Error('Unexpected sticker pack lookup'); }),
      send: vi.fn(async () => { throw new Error('Unexpected sticker delivery'); }),
    },
    convert: options.convert ?? vi.fn(async () => { throw new Error('Unexpected sticker conversion'); }),
  });
}

export function invocation(overrides: Partial<InvocationInput> = {}) {
  return createInvocation({ actorId: 1, source: 'telegram', botId: 12345,
    chat: { id: 1, type: 'private' }, language: 'en', ...overrides });
}

export async function coreFixture(options: {
  storage?: StorageOptions;
  services?: Partial<Pick<ActionServices, 'aiEnabled' | 'now' | 'capacity' | 'groupAdmin'>>;
  rss?: Partial<RssOptions>;
  rate?: RateOptions;
  weather?: WeatherOptions;
  sticker?: Parameters<typeof offlineStickers>[0];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'misaka-core-'));
  const storage = new JsonStorage(directory, options.storage);
  await storage.initialize();
  const access = new AccessService(storage, [1, 2]);
  const configuration = new ConfigurationService(storage);
  const aliases = new AliasService(storage, commands.map(command => command.name));
  await access.initialize();
  await configuration.initialize();
  await aliases.initialize();
  const rssSend = vi.fn(async () => {});
  const rss = new RssService(storage, { allowed: target => target.kind === 'private' || access.isAllowed(target.chatId), send: rssSend, ...options.rss });
  await rss.initialize();
  const rate = new RateService(storage, options.rate); await rate.initialize();
  const weather = new WeatherService(storage, options.weather); await weather.initialize();
  const stickers = offlineStickers(options.sticker);
  const subconv = new SubconvService(storage); await subconv.initialize();
  const effects = {
    describeGroup: vi.fn(async () => ({ title: '<untrusted> group', present: true })),
    notifyGroup: vi.fn(async () => true),
    leaveGroup: vi.fn(async () => true),
    syncPrivateMenu: vi.fn(async () => true),
  };
  const audit = vi.fn();
  const services: ActionServices = {
    access, configuration, aliases, rss, rate, weather, stickers, subconv, effects, audit,
    status: () => ({ uptimeSeconds: 1, updateCount: 2, authorizedGroupCount: access.count(), polling: 'running', http: 'disabled', lastApiError: null }),
    ...options.services,
  };
  const executor = new ActionExecutor(services);
  return { directory, storage, access, configuration, aliases, rss, rate, weather, stickers, subconv, rssSend, effects, audit, services, executor,
    close: async () => { await Promise.all([rss.stop(), rate.stop(), weather.stop(), stickers.stop(), subconv.stop()]); await executor.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); } };
}
