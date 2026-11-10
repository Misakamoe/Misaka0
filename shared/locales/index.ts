import enCommon from './en/common.json' with { type: 'json' };
import enBot from './en/bot.json' with { type: 'json' };
import enWeb from './en/web.json' with { type: 'json' };
import zhCommon from './zh-CN/common.json' with { type: 'json' };
import zhBot from './zh-CN/bot.json' with { type: 'json' };
import zhWeb from './zh-CN/web.json' with { type: 'json' };
import twCommon from './zh-TW/common.json' with { type: 'json' };
import twBot from './zh-TW/bot.json' with { type: 'json' };
import twWeb from './zh-TW/web.json' with { type: 'json' };
import jaCommon from './ja/common.json' with { type: 'json' };
import jaBot from './ja/bot.json' with { type: 'json' };
import jaWeb from './ja/web.json' with { type: 'json' };
import type { Locale } from '../schemas/index.js';

export const resources = {
  en: { common: enCommon, bot: enBot, web: enWeb },
  'zh-CN': { common: zhCommon, bot: zhBot, web: zhWeb },
  'zh-TW': { common: twCommon, bot: twBot, web: twWeb },
  ja: { common: jaCommon, bot: jaBot, web: jaWeb },
} satisfies Record<Locale, { common: unknown; bot: unknown; web: unknown }>;
