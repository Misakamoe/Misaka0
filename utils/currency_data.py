# utils/currency_data.py - 货币名称映射
"""
货币数据模块，提供货币代码、别名和符号的映射数据。
"""

# 法币别名和代码映射
FIAT_CURRENCY_ALIASES = {
    # 亚洲货币
    "人民币": "CNY",
    "rmb": "CNY",
    "cny": "CNY",
    "元": "CNY",
    "￥": "CNY",
    "日元": "JPY",
    "日币": "JPY",
    "jpy": "JPY",
    "¥": "JPY",
    "韩元": "KRW",
    "韩币": "KRW",
    "krw": "KRW",
    "₩": "KRW",
    "港币": "HKD",
    "港元": "HKD",
    "hkd": "HKD",
    "新加坡元": "SGD",
    "新币": "SGD",
    "sgd": "SGD",
    "台币": "TWD",
    "新台币": "TWD",
    "台湾元": "TWD",
    "twd": "TWD",
    "NT$": "TWD",
    "泰铢": "THB",
    "铢": "THB",
    "thb": "THB",
    "฿": "THB",
    "马来西亚林吉特": "MYR",
    "林吉特": "MYR",
    "myr": "MYR",
    "RM": "MYR",
    "印尼盾": "IDR",
    "盾": "IDR",
    "idr": "IDR",
    "Rp": "IDR",
    "菲律宾比索": "PHP",
    "菲币": "PHP",
    "php": "PHP",
    "₱": "PHP",
    "越南盾": "VND",
    "越盾": "VND",
    "vnd": "VND",
    "₫": "VND",
    "印度卢比": "INR",
    "卢比": "INR",
    "inr": "INR",
    "₹": "INR",

    # 中东货币
    "阿联酋迪拉姆": "AED",
    "迪拉姆": "AED",
    "aed": "AED",
    "د.إ": "AED",
    "沙特里亚尔": "SAR",
    "里亚尔": "SAR",
    "sar": "SAR",
    "﷼": "SAR",
    "以色列谢克尔": "ILS",
    "谢克尔": "ILS",
    "ils": "ILS",
    "₪": "ILS",

    # 美洲货币
    "美元": "USD",
    "美金": "USD",
    "刀": "USD",
    "usd": "USD",
    "$": "USD",
    "加元": "CAD",
    "加币": "CAD",
    "cad": "CAD",
    "巴西雷亚尔": "BRL",
    "雷亚尔": "BRL",
    "brl": "BRL",
    "R$": "BRL",
    "墨西哥比索": "MXN",
    "墨币": "MXN",
    "mxn": "MXN",
    "阿根廷比索": "ARS",
    "阿比索": "ARS",
    "ars": "ARS",
    "$a": "ARS",
    "智利比索": "CLP",
    "智比索": "CLP",
    "clp": "CLP",
    "哥伦比亚比索": "COP",
    "哥比索": "COP",
    "cop": "COP",
    "秘鲁索尔": "PEN",
    "索尔": "PEN",
    "pen": "PEN",
    "S/": "PEN",
    "乌拉圭比索": "UYU",
    "乌比索": "UYU",
    "uyu": "UYU",
    "$U": "UYU",
    "巴拉圭瓜拉尼": "PYG",
    "瓜拉尼": "PYG",
    "pyg": "PYG",
    "₲": "PYG",
    "玻利维亚诺": "BOB",
    "玻利维亚币": "BOB",
    "bob": "BOB",
    "Bs": "BOB",
    "委内瑞拉玻利瓦尔": "VES",
    "玻利瓦尔": "VES",
    "ves": "VES",
    "Bs.S": "VES",

    # 欧洲货币
    "欧元": "EUR",
    "欧": "EUR",
    "eur": "EUR",
    "€": "EUR",
    "英镑": "GBP",
    "镑": "GBP",
    "gbp": "GBP",
    "£": "GBP",
    "瑞士法郎": "CHF",
    "瑞郎": "CHF",
    "chf": "CHF",
    "俄罗斯卢布": "RUB",
    "卢布": "RUB",
    "rub": "RUB",
    "₽": "RUB",
    "瑞典克朗": "SEK",
    "瑞典币": "SEK",
    "sek": "SEK",
    "丹麦克朗": "DKK",
    "丹克朗": "DKK",
    "dkk": "DKK",
    "kr": "DKK",
    "挪威克朗": "NOK",
    "挪克朗": "NOK",
    "nok": "NOK",
    "波兰兹罗提": "PLN",
    "兹罗提": "PLN",
    "pln": "PLN",
    "zł": "PLN",
    "捷克克朗": "CZK",
    "捷克朗": "CZK",
    "czk": "CZK",
    "Kč": "CZK",
    "匈牙利福林": "HUF",
    "福林": "HUF",
    "huf": "HUF",
    "Ft": "HUF",
    "土耳其里拉": "TRY",
    "里拉": "TRY",
    "try": "TRY",
    "₺": "TRY",
    "冰岛克朗": "ISK",
    "冰克朗": "ISK",
    "isk": "ISK",
    "克罗地亚库纳": "HRK",
    "库纳": "HRK",
    "hrk": "HRK",
    "kn": "HRK",
    "罗马尼亚列伊": "RON",
    "列伊": "RON",
    "ron": "RON",
    "lei": "RON",
    "保加利亚列弗": "BGN",
    "列弗": "BGN",
    "bgn": "BGN",
    "лв": "BGN",
    "乌克兰格里夫纳": "UAH",
    "格里夫纳": "UAH",
    "uah": "UAH",
    "₴": "UAH",
    "白俄罗斯卢布尔": "BYN",
    "卢布尔": "BYN",
    "byn": "BYN",
    "Br": "BYN",
    "摩尔多瓦列伊": "MDL",
    "摩尔多瓦币": "MDL",
    "mdl": "MDL",
    "塞尔维亚第纳尔": "RSD",
    "塞尔维亚币": "RSD",
    "rsd": "RSD",
    "дин": "RSD",

    # 大洋洲货币
    "澳元": "AUD",
    "澳币": "AUD",
    "aud": "AUD",
    "新西兰元": "NZD",
    "纽币": "NZD",
    "nzd": "NZD",

    # 非洲货币
    "南非兰特": "ZAR",
    "兰特": "ZAR",
    "zar": "ZAR",
    "R": "ZAR",
    "埃及镑": "EGP",
    "埃镑": "EGP",
    "egp": "EGP",
    "E£": "EGP",
    "尼日利亚奈拉": "NGN",
    "奈拉": "NGN",
    "ngn": "NGN",
    "₦": "NGN",
    "肯尼亚先令": "KES",
    "肯先令": "KES",
    "kes": "KES",
    "KSh": "KES",
    "摩洛哥迪拉姆": "MAD",
    "摩洛哥币": "MAD",
    "mad": "MAD",
    "加纳塞地": "GHS",
    "塞地": "GHS",
    "ghs": "GHS",
    "GH₵": "GHS",
    "坦桑尼亚先令": "TZS",
    "坦先令": "TZS",
    "tzs": "TZS",
    "TSh": "TZS",
    "埃塞俄比亚比尔": "ETB",
    "比尔": "ETB",
    "etb": "ETB",
    "乌干达先令": "UGX",
    "乌先令": "UGX",
    "ugx": "UGX",
    "USh": "UGX",
    "卢旺达法郎": "RWF",
    "卢旺达币": "RWF",
    "rwf": "RWF",
    "RF": "RWF",
    "毛里求斯卢比": "MUR",
    "毛卢比": "MUR",
    "mur": "MUR",
    "Rs": "MUR",
    "博茨瓦纳普拉": "BWP",
    "普拉": "BWP",
    "bwp": "BWP",
    "P": "BWP",
    "纳米比亚元": "NAD",
    "纳元": "NAD",
    "nad": "NAD",
    "N$": "NAD",
    "塞舌尔卢比": "SCR",
    "塞卢比": "SCR",
    "scr": "SCR",
    "SR": "SCR",
    "突尼斯第纳尔": "TND",
    "突第纳尔": "TND",
    "tnd": "TND",
    "DT": "TND",
    "阿尔及利亚第纳尔": "DZD",
    "阿第纳尔": "DZD",
    "dzd": "DZD",
    "DA": "DZD",
    "利比亚第纳尔": "LYD",
    "利第纳尔": "LYD",
    "lyd": "LYD",
    "LD": "LYD",

    # 中亚货币
    "哈萨克斯坦坚戈": "KZT",
    "坚戈": "KZT",
    "kzt": "KZT",
    "₸": "KZT",
    "亚美尼亚德拉姆": "AMD",
    "德拉姆": "AMD",
    "amd": "AMD",
    "֏": "AMD",
    "格鲁吉亚拉里": "GEL",
    "拉里": "GEL",
    "gel": "GEL",
    "₾": "GEL",
    "阿塞拜疆马纳特": "AZN",
    "马纳特": "AZN",
    "azn": "AZN",
    "₼": "AZN",

    # 国家/地区名称映射
    "中国": "CNY",
    "china": "CNY",
    "cn": "CNY",
    "chinese": "CNY",
    "美国": "USD",
    "usa": "USD",
    "us": "USD",
    "america": "USD",
    "american": "USD",
    "欧洲": "EUR",
    "欧盟": "EUR",
    "europe": "EUR",
    "eu": "EUR",
    "european": "EUR",
    "英国": "GBP",
    "uk": "GBP",
    "gb": "GBP",
    "britain": "GBP",
    "british": "GBP",
    "日本": "JPY",
    "japan": "JPY",
    "jp": "JPY",
    "japanese": "JPY",
    "韩国": "KRW",
    "korea": "KRW",
    "kr": "KRW",
    "korean": "KRW",
    "香港": "HKD",
    "hongkong": "HKD",
    "hk": "HKD",
    "澳大利亚": "AUD",
    "australia": "AUD",
    "au": "AUD",
    "australian": "AUD",
    "加拿大": "CAD",
    "canada": "CAD",
    "ca": "CAD",
    "canadian": "CAD",
    "瑞士": "CHF",
    "switzerland": "CHF",
    "ch": "CHF",
    "swiss": "CHF",
    "新加坡": "SGD",
    "singapore": "SGD",
    "sg": "SGD",
    "singaporean": "SGD",
    "俄罗斯": "RUB",
    "russia": "RUB",
    "ru": "RUB",
    "russian": "RUB",
    "法国": "EUR",
    "france": "EUR",
    "fr": "EUR",
    "french": "EUR",
    "德国": "EUR",
    "germany": "EUR",
    "de": "EUR",
    "german": "EUR",
    "意大利": "EUR",
    "italy": "EUR",
    "it": "EUR",
    "italian": "EUR",
    "西班牙": "EUR",
    "spain": "EUR",
    "es": "EUR",
    "spanish": "EUR",
    "新西兰": "NZD",
    "newzealand": "NZD",
    "nz": "NZD",
    "印度": "INR",
    "india": "INR",
    "in": "INR",
    "indian": "INR",
    "巴西": "BRL",
    "brazil": "BRL",
    "br": "BRL",
    "brazilian": "BRL",
    "墨西哥": "MXN",
    "mexico": "MXN",
    "mx": "MXN",
    "mexican": "MXN",
    "南非": "ZAR",
    "southafrica": "ZAR",
    "za": "ZAR",
    "瑞典": "SEK",
    "sweden": "SEK",
    "se": "SEK",
    "swedish": "SEK",
    "泰国": "THB",
    "thailand": "THB",
    "th": "THB",
    "thai": "THB",
    "马来西亚": "MYR",
    "malaysia": "MYR",
    "my": "MYR",
    "malaysian": "MYR",
    "印度尼西亚": "IDR",
    "indonesia": "IDR",
    "id": "IDR",
    "indonesian": "IDR",
    "菲律宾": "PHP",
    "philippines": "PHP",
    "ph": "PHP",
    "philippine": "PHP",
    "越南": "VND",
    "vietnam": "VND",
    "vn": "VND",
    "vietnamese": "VND",
    "台湾": "TWD",
    "taiwan": "TWD",
    "tw": "TWD",
    "taiwanese": "TWD",
    "阿联酋": "AED",
    "uae": "AED",
    "ae": "AED",
    "emirates": "AED",
    "沙特": "SAR",
    "沙特阿拉伯": "SAR",
    "saudiarabia": "SAR",
    "sa": "SAR",
    "saudi": "SAR",
    "丹麦": "DKK",
    "denmark": "DKK",
    "dk": "DKK",
    "danish": "DKK",
    "挪威": "NOK",
    "norway": "NOK",
    "no": "NOK",
    "norwegian": "NOK",
    "土耳其": "TRY",
    "turkey": "TRY",
    "tr": "TRY",
    "turkish": "TRY",
    "波兰": "PLN",
    "poland": "PLN",
    "pl": "PLN",
    "polish": "PLN",
    "以色列": "ILS",
    "israel": "ILS",
    "il": "ILS",
    "israeli": "ILS",
    "埃及": "EGP",
    "egypt": "EGP",
    "eg": "EGP",
    "egyptian": "EGP",
    "哥伦比亚": "COP",
    "colombia": "COP",
    "co": "COP",
    "colombian": "COP",
    "智利": "CLP",
    "chile": "CLP",
    "cl": "CLP",
    "chilean": "CLP",
    "阿根廷": "ARS",
    "argentina": "ARS",
    "ar": "ARS",
    "argentinian": "ARS",
    "捷克": "CZK",
    "czechrepublic": "CZK",
    "cz": "CZK",
    "czech": "CZK",
    "匈牙利": "HUF",
    "hungary": "HUF",
    "hu": "HUF",
    "hungarian": "HUF",
    "冰岛": "ISK",
    "iceland": "ISK",
    "is": "ISK",
    "icelandic": "ISK",
    "克罗地亚": "HRK",
    "croatia": "HRK",
    "hr": "HRK",
    "croatian": "HRK",
    "罗马尼亚": "RON",
    "romania": "RON",
    "ro": "RON",
    "romanian": "RON",
    "保加利亚": "BGN",
    "bulgaria": "BGN",
    "bg": "BGN",
    "bulgarian": "BGN",
    "乌克兰": "UAH",
    "ukraine": "UAH",
    "ua": "UAH",
    "ukrainian": "UAH",
    "白俄罗斯": "BYN",
    "belarus": "BYN",
    "by": "BYN",
    "belarusian": "BYN",
    "摩尔多瓦": "MDL",
    "moldova": "MDL",
    "md": "MDL",
    "moldovan": "MDL",
    "塞尔维亚": "RSD",
    "serbia": "RSD",
    "rs": "RSD",
    "serbian": "RSD",
    "尼日利亚": "NGN",
    "nigeria": "NGN",
    "ng": "NGN",
    "nigerian": "NGN",
    "肯尼亚": "KES",
    "kenya": "KES",
    "ke": "KES",
    "kenyan": "KES",
    "摩洛哥": "MAD",
    "morocco": "MAD",
    "ma": "MAD",
    "moroccan": "MAD",
    "加纳": "GHS",
    "ghana": "GHS",
    "gh": "GHS",
    "ghanaian": "GHS",
    "坦桑尼亚": "TZS",
    "tanzania": "TZS",
    "tz": "TZS",
    "tanzanian": "TZS",
    "埃塞俄比亚": "ETB",
    "ethiopia": "ETB",
    "et": "ETB",
    "ethiopian": "ETB",
    "乌干达": "UGX",
    "uganda": "UGX",
    "ug": "UGX",
    "ugandan": "UGX",
    "卢旺达": "RWF",
    "rwanda": "RWF",
    "rw": "RWF",
    "rwandan": "RWF",
    "毛里求斯": "MUR",
    "mauritius": "MUR",
    "mu": "MUR",
    "mauritian": "MUR",
    "博茨瓦纳": "BWP",
    "botswana": "BWP",
    "bw": "BWP",
    "纳米比亚": "NAD",
    "namibia": "NAD",
    "na": "NAD",
    "namibian": "NAD",
    "塞舌尔": "SCR",
    "seychelles": "SCR",
    "sc": "SCR",
    "seychellois": "SCR",
    "突尼斯": "TND",
    "tunisia": "TND",
    "tn": "TND",
    "tunisian": "TND",
    "阿尔及利亚": "DZD",
    "algeria": "DZD",
    "dz": "DZD",
    "algerian": "DZD",
    "利比亚": "LYD",
    "libya": "LYD",
    "ly": "LYD",
    "libyan": "LYD",
    "哈萨克斯坦": "KZT",
    "kazakhstan": "KZT",
    "kz": "KZT",
    "亚美尼亚": "AMD",
    "armenia": "AMD",
    "am": "AMD",
    "armenian": "AMD",
    "格鲁吉亚": "GEL",
    "georgia": "GEL",
    "ge": "GEL",
    "georgian": "GEL",
    "阿塞拜疆": "AZN",
    "azerbaijan": "AZN",
    "az": "AZN",
    "azerbaijani": "AZN",
    "秘鲁": "PEN",
    "peru": "PEN",
    "pe": "PEN",
    "peruvian": "PEN",
    "乌拉圭": "UYU",
    "uruguay": "UYU",
    "uy": "UYU",
    "uruguayan": "UYU",
    "巴拉圭": "PYG",
    "paraguay": "PYG",
    "py": "PYG",
    "paraguayan": "PYG",
    "玻利维亚": "BOB",
    "bolivia": "BOB",
    "bo": "BOB",
    "bolivian": "BOB",
    "委内瑞拉": "VES",
    "venezuela": "VES",
    "ve": "VES",
    "venezuelan": "VES",
}

# 虚拟货币别名和代码映射
CRYPTO_CURRENCY_ALIASES = {
    "比特币": "bitcoin",
    "btc": "bitcoin",
    "bitcoin": "bitcoin",
    "以太坊": "ethereum",
    "eth": "ethereum",
    "ethereum": "ethereum",
    "莱特币": "litecoin",
    "ltc": "litecoin",
    "litecoin": "litecoin",
    "瑞波币": "ripple",
    "xrp": "ripple",
    "ripple": "ripple",
    "币安币": "binancecoin",
    "bnb": "binancecoin",
    "binancecoin": "binancecoin",
    "狗狗币": "dogecoin",
    "doge": "dogecoin",
    "dogecoin": "dogecoin",
    "波卡": "polkadot",
    "dot": "polkadot",
    "polkadot": "polkadot",
    "卡尔达诺": "cardano",
    "ada": "cardano",
    "cardano": "cardano",
    "索拉纳": "solana",
    "sol": "solana",
    "solana": "solana",
    "泰达币": "tether",
    "usdt": "tether",
    "tether": "tether",
    "usd币": "usd-coin",
    "usdc": "usd-coin",
    "usd-coin": "usd-coin",
    "链接": "chainlink",
    "link": "chainlink",
    "chainlink": "chainlink",
    "uniswap": "uniswap",
    "uni": "uniswap",
    "优尼币": "uniswap",
    "sushi": "sushiswap",
    "sushiswap": "sushiswap",
    "寿司币": "sushiswap",
    "aave": "aave",
    "compound": "compound",
    "comp": "compound",
    "复合币": "compound",
    "maker": "maker",
    "mkr": "maker",
    "制造者": "maker",
    "dash": "dash",
    "达世币": "dash",
    "monero": "monero",
    "xmr": "monero",
    "门罗币": "monero",
    "zcash": "zcash",
    "zec": "zcash",
    "大零币": "zcash",
    "恒星币": "stellar",
    "xlm": "stellar",
    "stellar": "stellar",
    "eos": "eos",
    "柚子币": "eos",
    "tron": "tron",
    "trx": "tron",
    "波场": "tron",
    "neo": "neo",
    "小蚁币": "neo",
    "nem": "nem",
    "xem": "nem",
    "新经币": "nem",
    "iota": "iota",
    "miota": "iota",
    "埃欧塔": "iota",
    "vechain": "vechain",
    "vet": "vechain",
    "唯链": "vechain",
    "filecoin": "filecoin",
    "fil": "filecoin",
    "文件币": "filecoin",
    "avalanche": "avalanche-2",
    "avax": "avalanche-2",
    "雪崩币": "avalanche-2",
    "cosmos": "cosmos",
    "atom": "cosmos",
    "宇宙币": "cosmos",
    "algorand": "algorand",
    "algo": "algorand",
    "算法币": "algorand",
    "tezos": "tezos",
    "xtz": "tezos",
    "太佐斯": "tezos",
    "theta": "theta-token",
    "theta-token": "theta-token",
    "theta币": "theta-token",
    "decentraland": "decentraland",
    "mana": "decentraland",
    "虚拟土地": "decentraland",
    "axie-infinity": "axie-infinity",
    "axs": "axie-infinity",
    "无限轴": "axie-infinity",
    "shiba-inu": "shiba-inu",
    "shib": "shiba-inu",
    "柴犬币": "shiba-inu",
    "pancakeswap": "pancakeswap-token",
    "cake": "pancakeswap-token",
    "煎饼币": "pancakeswap-token",
    "fantom": "fantom",
    "ftm": "fantom",
    "幻影币": "fantom",
    "polygon": "polygon",
    "matic": "polygon",
    "多边形": "polygon",
    "近币": "near",
    "near": "near",
    "terra": "terra-luna",
    "luna": "terra-luna",
    "月球币": "terra-luna",
    "the-sandbox": "the-sandbox",
    "sand": "the-sandbox",
    "沙盒币": "the-sandbox",
    "流量币": "flow",
    "flow": "flow",
    "gala": "gala",
    "gala币": "gala",
    "基本注意力代币": "basic-attention-token",
    "bat": "basic-attention-token",
    "basic-attention-token": "basic-attention-token",
    "hedera": "hedera-hashgraph",
    "hbar": "hedera-hashgraph",
    "hedera-hashgraph": "hedera-hashgraph",
    "elrond": "elrond-erd-2",
    "egld": "elrond-erd-2",
    "elrond-erd-2": "elrond-erd-2",
    "kusama": "kusama",
    "ksm": "kusama",
    "草间弥生": "kusama",
    "celo": "celo",
    "塞洛": "celo",
    "chiliz": "chiliz",
    "chz": "chiliz",
    "奇利币": "chiliz",
    "enjin": "enjincoin",
    "enj": "enjincoin",
    "enjincoin": "enjincoin",
    "arweave": "arweave",
    "ar": "arweave",
    "永存币": "arweave",
    "harmony": "harmony",
    "one": "harmony",
    "和谐币": "harmony",
    "quant": "quant-network",
    "qnt": "quant-network",
    "quant-network": "quant-network",
    "icp": "internet-computer",
    "互联网计算机": "internet-computer",
    "internet-computer": "internet-computer",
    "dai": "dai",
    "戴币": "dai",
    "frax": "frax",
    "frax币": "frax",
    "true-usd": "true-usd",
    "tusd": "true-usd",
    "真实美元": "true-usd",
    "paxos-standard": "paxos-standard",
    "pax": "paxos-standard",
    "paxos标准币": "paxos-standard",
    "huobi-token": "huobi-token",
    "ht": "huobi-token",
    "火币币": "huobi-token",
    "okb": "okb",
    "ok币": "okb",
    "kucoin-shares": "kucoin-shares",
    "kcs": "kucoin-shares",
    "库币": "kucoin-shares",
    "ftx-token": "ftx-token",
    "ftt": "ftx-token",
    "ftx币": "ftx-token",
    "bittorrent": "bittorrent-2",
    "btt": "bittorrent-2",
    "比特流": "bittorrent-2",
    "bittorrent-2": "bittorrent-2",
    "zilliqa": "zilliqa",
    "zil": "zilliqa",
    "齐利亚": "zilliqa",
    "ontology": "ontology",
    "ont": "ontology",
    "本体币": "ontology",
    "ravencoin": "ravencoin",
    "rvn": "ravencoin",
    "渡鸦币": "ravencoin",
    "omisego": "omisego",
    "omg": "omisego",
    "欧姆币": "omisego",
}

# 货币符号映射
CURRENCY_SYMBOLS = {
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "CNY": "￥",
    "KRW": "₩",
    "RUB": "₽",
    "INR": "₹",
    "THB": "฿",
    "PHP": "₱",
    "VND": "₫",
    "ILS": "₪",
    "TRY": "₺",
    "PLN": "zł",
    "BRL": "R$",
    "MYR": "RM",
    "IDR": "Rp",
    "ARS": "$a",
    "CZK": "Kč",
    "HUF": "Ft",
    "HRK": "kn",
    "RON": "lei",
    "BGN": "лв",
    "SAR": "﷼",
    "AED": "د.إ",
    "TWD": "NT$",
    "DKK": "kr",
    "NOK": "kr",
    "SEK": "kr",
    "ISK": "kr",
    "ZAR": "R",
    "EGP": "E£",
    "UAH": "₴",
    "KZT": "₸",
    "PEN": "S/",
    "BYN": "Br",
    "AMD": "֏",
    "GEL": "₾",
    "RSD": "дин",
    "AZN": "₼",
    "NGN": "₦",
    "GHS": "GH₵",
    "PYG": "₲",
    "NAD": "N$",
    "SCR": "SR",
    "TND": "DT",
    "DZD": "DA",
    "LYD": "LD",
    "KES": "KSh",
    "MAD": "MAD",
    "TZS": "TSh",
    "UGX": "USh",
    "RWF": "RF",
    "MUR": "Rs",
    "BWP": "P",
}


class CurrencyData:
    """货币数据管理类，提供货币数据查询功能。"""

    @classmethod
    def get_fiat_aliases(cls):
        """获取法币别名映射。

        Returns:
            dict: 法币别名到货币代码的映射字典
        """
        return FIAT_CURRENCY_ALIASES

    @classmethod
    def get_crypto_aliases(cls):
        """获取虚拟货币别名映射。

        Returns:
            dict: 虚拟货币别名到货币代码的映射字典
        """
        return CRYPTO_CURRENCY_ALIASES

    @classmethod
    def get_currency_symbols(cls):
        """获取货币符号映射。

        Returns:
            dict: 货币代码到货币符号的映射字典
        """
        return CURRENCY_SYMBOLS

    @classmethod
    def get_currency_code(cls, currency_name):
        """获取货币代码，支持别名和国家名称。

        Args:
            currency_name (str): 货币名称，可以是货币代码、别名或国家名称

        Returns:
            tuple: (货币代码, 货币类型)，货币类型为 'fiat' 或 'crypto'，
                  如果找不到匹配的货币，则返回 (None, None)
        """
        # 转换为小写并去除空格
        name = currency_name.lower().strip()

        # 检查法币别名
        for alias, code in FIAT_CURRENCY_ALIASES.items():
            if name == alias.lower():
                return code, "fiat"

        # 检查虚拟货币别名
        for alias, code in CRYPTO_CURRENCY_ALIASES.items():
            if name == alias.lower():
                return code, "crypto"

        # 如果找不到匹配
        return None, None

    @classmethod
    def format_currency_amount(cls, amount, currency_code, currency_type):
        """格式化货币金额，根据货币类型和代码使用适当的格式。

        Args:
            amount (float): 金额数值
            currency_code (str): 货币代码
            currency_type (str): 货币类型，'fiat' 或 'crypto'

        Returns:
            str: 格式化后的金额字符串，包含货币符号或代码
        """
        if currency_type == "fiat":
            # 获取货币符号
            symbol = CURRENCY_SYMBOLS.get(currency_code, "")

            # 根据不同货币使用不同的小数位数
            if currency_code in [
                    "JPY", "KRW", "IDR", "VND", "HUF", "ISK", "CLP", "PYG",
                    "UGX", "RWF"
            ]:
                # 这些货币通常不使用小数
                formatted = f"{symbol}{amount:.0f}" if symbol else f"{amount:.0f} {currency_code}"
            else:
                formatted = f"{symbol}{amount:.2f}" if symbol else f"{amount:.2f} {currency_code}"

            return formatted
        else:
            # 虚拟货币通常使用更多小数位
            if amount < 0.001:
                return f"{amount:.8f} {currency_code.upper()}"
            elif amount < 1:
                return f"{amount:.6f} {currency_code.upper()}"
            else:
                return f"{amount:.4f} {currency_code.upper()}"
