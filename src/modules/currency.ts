import currencyData from 'cldr-core/supplemental/currencyData.json' with { type: 'json' };
import { Decimal } from 'decimal.js';
const Money = Decimal.clone({ precision: 48 });

export interface CurrencyDefinition { code: string; name: string; kind: 'fiat' | 'crypto'; coinId?: string }
const cryptoRows = [
  'BTC|bitcoin|Bitcoin|比特币|比特幣|ビットコイン', 'ETH|ethereum|Ethereum|以太坊|イーサリアム',
  'LTC|litecoin|Litecoin|莱特币|萊特幣', 'XRP|ripple|XRP|瑞波币|瑞波幣', 'BNB|binancecoin|BNB|币安币|幣安幣',
  'DOGE|dogecoin|Dogecoin|狗狗币|狗狗幣', 'DOT|polkadot|Polkadot|波卡', 'ADA|cardano|Cardano|卡尔达诺|卡爾達諾',
  'SOL|solana|Solana|索拉纳|索拉納', 'USDT|tether|Tether|泰达币|泰達幣', 'USDC|usd-coin|USD Coin|usd币|usd幣',
  'LINK|chainlink|Chainlink|链接|鏈接', 'UNI|uniswap|Uniswap|优尼币|優尼幣', 'SUSHI|sushiswap|Sushiswap|寿司币|壽司幣',
  'AAVE|aave|Aave', 'COMP|compound|Compound|复合币|複合幣', 'MKR|maker|Maker|制造者|製造者',
  'DASH|dash|Dash|达世币|達世幣', 'XMR|monero|Monero|门罗币|門羅幣', 'ZEC|zcash|Zcash|大零币|大零幣',
  'XLM|stellar|Stellar|恒星币|恆星幣', 'EOS|eos|EOS|柚子币|柚子幣', 'TRX|tron|Tron|波场|波場',
  'NEO|neo|NEO|小蚁币|小蟻幣', 'XEM|nem|NEM|新经币|新經幣', 'MIOTA|iota|IOTA|埃欧塔|埃歐塔',
  'VET|vechain|VeChain|唯链|唯鏈', 'FIL|filecoin|Filecoin|文件币|文件幣', 'AVAX|avalanche-2|Avalanche|avalanche|雪崩币|雪崩幣',
  'ATOM|cosmos|Cosmos|宇宙币|宇宙幣', 'ALGO|algorand|Algorand|算法币|算法幣', 'XTZ|tezos|Tezos|太佐斯',
  'THETA|theta-token|Theta|theta币|theta幣', 'MANA|decentraland|Decentraland|虚拟土地|虛擬土地',
  'AXS|axie-infinity|Axie Infinity|无限轴|無限軸', 'SHIB|shiba-inu|Shiba Inu|柴犬币|柴犬幣',
  'CAKE|pancakeswap-token|PancakeSwap|pancakeswap|煎饼币|煎餅幣', 'FTM|fantom|Fantom|幻影币|幻影幣',
  'MATIC|matic-network|Polygon MATIC|matic|多边形|多邊形', 'POL|polygon-ecosystem-token|Polygon POL|polygon',
  'NEAR|near|NEAR|近币|近幣', 'LUNA|terra-luna-2|Terra|月球币|月球幣', 'LUNC|terra-luna|Terra Classic',
  'SAND|the-sandbox|The Sandbox|沙盒币|沙盒幣', 'FLOW|flow|Flow|流量币|流量幣', 'GALA|gala|Gala|gala币|gala幣',
  'BAT|basic-attention-token|Basic Attention Token|基本注意力代币|基本注意力代幣',
  'HBAR|hedera-hashgraph|Hedera|hedera', 'EGLD|elrond-erd-2|MultiversX|elrond', 'KSM|kusama|Kusama|草间弥生|草間彌生',
  'CELO|celo|Celo|塞洛', 'CHZ|chiliz|Chiliz|奇利币|奇利幣', 'ENJ|enjincoin|Enjin|enjin|恩金币|恩金幣',
  'AR|arweave|Arweave|永存币|永存幣', 'ONE|harmony|Harmony|和谐币|和諧幣', 'QNT|quant-network|Quant|quant',
  'ICP|internet-computer|Internet Computer|互联网计算机|互聯網計算機', 'DAI|dai|DAI|戴币|戴幣', 'FRAX|frax|Frax|frax币|frax幣',
  'TUSD|true-usd|TrueUSD|真实美元|真實美元', 'USDP|paxos-standard|Pax Dollar|pax|paxos标准币|paxos標準幣',
  'HT|huobi-token|Huobi Token|火币币|火幣幣', 'OKB|okb|OKB|ok币|ok幣', 'KCS|kucoin-shares|KuCoin Token|库币|庫幣',
  'FTT|ftx-token|FTX Token|ftx币|ftx幣', 'BTT|bittorrent-2|BitTorrent|bittorrent|比特流',
  'ZIL|zilliqa|Zilliqa|齐利亚|齊利亞', 'ONT|ontology|Ontology|本体币|本體幣', 'RVN|ravencoin|Ravencoin|渡鸦币|渡鴉幣', 'OMG|omisego|OMG|欧姆币|歐姆幣',
];
export const cryptoCurrencies: readonly CurrencyDefinition[] = Object.freeze(cryptoRows.map(row => {
  const [code, coinId, name] = row.split('|'); return Object.freeze({ code: code!, coinId: coinId!, name: name!, kind: 'crypto' as const });
}));
const common: Record<string, string[]> = {
  CNY: ['rmb', '人民币', '人民幣', '人民币元', '人民元', '元', '块', '塊', 'yuan', 'renminbi', '中国大陆', '中國大陸', '中国', '中國'],
  JPY: ['日元', '日圆', '日圓', '日币', '日幣', '円', 'yen'], USD: ['美元', '美金', '美刀', '刀', 'usa', 'us$', 'u.s. dollar', 'u.s. dollars'],
  EUR: ['欧元', '歐元', '欧', '歐', '欧盟', '歐盟', '欧元区', '歐元區', 'eu', 'eurozone', 'euros'],
  GBP: ['英镑', '英鎊', '镑', '鎊', 'uk', 'british pound', 'british pounds', 'sterling'],
  HKD: ['港币', '港幣', '港元', '香港', 'hong kong', 'hk$'], TWD: ['台币', '台幣', '新台币', '新台幣', '台湾元', '臺灣元', '台湾', '台灣', 'nt$', 'ntd'],
  MOP: ['澳門', '澳门', '澳门币', '澳門幣', 'pataca'], KRW: ['韩元', '韓元', '韩币', '韓幣', '韩国', '韓國', 'south korea', 'won'],
  SGD: ['新币', '新幣', '新加坡元', '新加坡', 's$'], AUD: ['澳元', '澳币', '澳幣', 'a$', 'au$'], CAD: ['加元', '加币', '加幣', 'ca$', 'c$'],
  NZD: ['纽元', '紐元', '纽币', '紐幣', 'nz$'], CHF: ['瑞郎', '瑞士法郎'], RUB: ['卢布', '盧布', '俄罗斯卢布', '俄羅斯盧布'],
  THB: ['泰铢', '泰銖', '铢', '銖', 'baht'], VND: ['越盾', '越南盾', 'dong'], IDR: ['印尼盾', '印尼卢比', '印尼盧比', 'rupiah'],
  MYR: ['林吉特', '令吉', '马币', '馬幣', 'ringgit', 'rm'], INR: ['印度卢比', '印度盧比'], AED: ['阿联酋迪拉姆', '阿聯酋迪拉姆'],
};
const locales = ['zh-CN', 'zh-TW', 'en', 'ja'] as const;
function normalized(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[\s\u00b7\u30fb]+/g, ' ').trim(); }
export class CurrencyParseError extends Error {
  constructor(readonly code: 'QUERY' | 'AMOUNT' | 'CURRENCY') { super(code); }
}
export type CurrencyParse = { kind: 'conversion'; amount: string; from: string; to: string }
  | { kind: 'ambiguous'; amount: string; from: string[]; to: string[] };
export function parseAmount(input: string): string {
  let value = input.normalize('NFKC').trim();
  if (!value) return '1';
  value = value.replace(/萬/g, '万').replace(/億/g, '亿').replace(/兩/g, '两');
  let amount: Decimal;
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九十百千万亿]+(?:[点點][零〇一二两三四五六七八九]+)?$/.test(value)) {
    const [whole, fraction = ''] = value.split(/[点點]/);
    if (/([十百千万亿])\1|亿万|十百|十千|百千/.test(whole!)) throw new CurrencyParseError('AMOUNT');
    if (/[百千万亿][一二两三四五六七八九]$/.test(whole!)) throw new CurrencyParseError('AMOUNT');
    let total = 0; let section = 0; let digit = 0;
    if (/^[零〇一二两三四五六七八九]+$/.test(whole!)) total = Number([...whole!].map(char => digits[char]).join(''));
    else for (const char of whole!) {
      if (char in digits) digit = digits[char]!;
      else {
        const unit = ({ 十: 10, 百: 100, 千: 1000, 万: 10_000, 亿: 100_000_000 } as Record<string, number>)[char]!;
        if (unit < 10_000) section += (digit || 1) * unit;
        else if (unit === 10_000) { total += (section + digit || 1) * unit; section = 0; }
        else { total = (total + section + digit || 1) * unit; section = 0; }
        digit = 0;
      }
    }
    amount = new Money(String(total + section + digit) + (fraction ? '.' + [...fraction].map(char => digits[char]).join('') : ''));
  } else {
    const match = /^((?:\d{1,3}(?:,\d{3})+|\d+|(?=\.))(?:\.\d{1,12})?)([kwmb万亿千百])?$/i.exec(value);
    if (!match) throw new CurrencyParseError('AMOUNT');
    const scale = ({ k: 1000, w: 10_000, m: 1_000_000, b: 1_000_000_000, 万: 10_000, 亿: 100_000_000, 千: 1000, 百: 100 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1;
    amount = new Money(match[1]!.replaceAll(',', '')).mul(scale);
  }
  if (!amount.isFinite() || amount.isNegative() || amount.gt('1e15') || amount.decimalPlaces() > 12) throw new CurrencyParseError('AMOUNT');
  return amount.toFixed();
}

export class CurrencyCatalog {
  private readonly definitions = new Map<string, CurrencyDefinition>();
  private readonly aliases = new Map<string, Set<string>>();
  private readonly names: string[];
  constructor(codes: readonly (readonly [string, string])[], now = Date.now()) {
    for (const [code, name] of codes) if (/^[A-Z]{3}$/.test(code)) this.definitions.set(code, { code, name, kind: 'fiat' });
    for (const item of cryptoCurrencies) if (!this.definitions.has(item.code)) this.definitions.set(item.code, item);
    const add = (name: string, code: string) => {
      if (!this.definitions.has(code)) return;
      const alias = normalized(name);
      if (!alias) return;
      let choices = this.aliases.get(alias);
      if (!choices) this.aliases.set(alias, choices = new Set());
      choices.add(code);
    };
    for (const item of this.definitions.values()) { add(item.code, item.code); add(`${item.kind}:${item.code}`, item.code); add(item.name, item.code); }
    for (const locale of locales) {
      const currencyNames = new Intl.DisplayNames(locale, { type: 'currency' });
      for (const item of this.definitions.values()) if (item.kind === 'fiat') {
        const name = currencyNames.of(item.code)!;
        add(name, item.code);
        if (locale === 'en' && /(?:dollar|pound|franc|euro|peso|dinar|dirham|rupee|shilling|krona|rupee)$/i.test(name)) add(name + 's', item.code);
        if (locale === 'en') {
          const family = /\b(dollar|pound|franc|peso|dinar|dirham|rupee|shilling|krona)$/i.exec(name)?.[1]?.toLowerCase();
          if (family) {
            add(family, item.code); add(family + 's', item.code);
            for (const translated of ({ dollar: ['ドル'], franc: ['法郎', 'フラン'], rupee: ['卢比', '盧比', 'ルピー'], peso: ['比索', 'ペソ'], dinar: ['第纳尔', '第納爾', 'ディナール'], dirham: ['迪拉姆', 'ディルハム'], krona: ['克朗'] } as Record<string, string[]>)[family] ?? []) add(translated, item.code);
          }
        }
        const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency: item.code, currencyDisplay: 'narrowSymbol' }).formatToParts(1).find(part => part.type === 'currency')?.value;
        if (symbol) add(symbol, item.code);
      }
    }
    const date = new Date(now).toISOString().slice(0, 10);
    const regions = currencyData.supplemental.currencyData.region as unknown as Record<string, Record<string, { _from?: string; _to?: string; _tender?: string }>[]>;
    for (const [region, rows] of Object.entries(regions)) for (const row of rows) for (const [code, period] of Object.entries(row)) {
      if (period._tender === 'false' || period._from && period._from > date || period._to && period._to < date) continue;
      add(region, code);
      for (const locale of locales) add(new Intl.DisplayNames(locale, { type: 'region' }).of(region)!, code);
    }
    for (const [code, aliases] of Object.entries(common)) for (const alias of aliases) add(alias, code);
    for (const row of cryptoRows) { const [code, ...aliases] = row.split('|'); for (const alias of aliases) add(alias, code!); }
    this.names = [...this.aliases.keys()].sort((left, right) => right.length - left.length);
  }
  list(): readonly CurrencyDefinition[] { return [...this.definitions.values()]; }
  resolve(term: string): readonly CurrencyDefinition[] {
    return [...(this.aliases.get(normalized(term)) ?? [])].map(code => this.definitions.get(code)!);
  }
  parse(query: string): CurrencyParse {
    if (!query.trim() || query.length > 500 || /\p{Cc}/u.test(query)) throw new CurrencyParseError('QUERY');
    const source = normalized(query);
    const currencies: string[][] = [];
    let remaining = '';
    for (let position = 0; position < source.length;) {
      const alias = this.names.find(name => source.startsWith(name, position)
        && !(/^[kwmb]$/.test(name) && /\d/.test(source[position - 1] ?? ''))
        && !(/[a-z]/.test(name[0]!) && /[a-z]/.test(source[position - 1] ?? ''))
        && !(/[a-z]/.test(name.at(-1)!) && /[a-z]/.test(source[position + name.length] ?? '')));
      if (alias) { currencies.push([...this.aliases.get(alias)!]); remaining += ' '; position += alias.length; }
      else { remaining += source[position]; position += 1; }
    }
    if (currencies.length !== 2) throw new CurrencyParseError('CURRENCY');
    const amount = parseAmount(remaining.trim());
    const from = currencies[0]!; const to = currencies[1]!;
    return from.length === 1 && to.length === 1 ? { kind: 'conversion', amount, from: from[0]!, to: to[0]! } : { kind: 'ambiguous', amount, from, to };
  }
}
