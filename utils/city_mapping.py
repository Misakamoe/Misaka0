# utils/city_mapping.py - 城市名称映射
"""
城市名称映射工具
提供中文城市名到英文城市名的转换
"""

# 中文城市名称到英文名称的映射
CHINESE_TO_ENGLISH_CITIES = {
    # === 直辖市 ===
    "北京": "Beijing",
    "北京市": "Beijing",
    "上海": "Shanghai",
    "上海市": "Shanghai",
    "天津": "Tianjin",
    "天津市": "Tianjin",
    "重庆": "Chongqing",
    "重庆市": "Chongqing",

    # === 省份 ===
    "广东": "Guangdong",
    "广东省": "Guangdong",
    "江苏": "Jiangsu",
    "江苏省": "Jiangsu",
    "山东": "Shandong",
    "山东省": "Shandong",
    "浙江": "Zhejiang",
    "浙江省": "Zhejiang",
    "河南": "Henan",
    "河南省": "Henan",
    "河北": "Hebei",
    "河北省": "Hebei",
    "四川": "Sichuan",
    "四川省": "Sichuan",
    "湖北": "Hubei",
    "湖北省": "Hubei",
    "湖南": "Hunan",
    "湖南省": "Hunan",
    "福建": "Fujian",
    "福建省": "Fujian",
    "安徽": "Anhui",
    "安徽省": "Anhui",
    "辽宁": "Liaoning",
    "辽宁省": "Liaoning",
    "江西": "Jiangxi",
    "江西省": "Jiangxi",
    "陕西": "Shaanxi",
    "陕西省": "Shaanxi",
    "山西": "Shanxi",
    "山西省": "Shanxi",
    "黑龙江": "Heilongjiang",
    "黑龙江省": "Heilongjiang",
    "吉林": "Jilin",
    "吉林省": "Jilin",
    "云南": "Yunnan",
    "云南省": "Yunnan",
    "贵州": "Guizhou",
    "贵州省": "Guizhou",
    "广西": "Guangxi",
    "广西壮族自治区": "Guangxi",
    "甘肃": "Gansu",
    "甘肃省": "Gansu",
    "内蒙古": "Inner Mongolia",
    "内蒙古自治区": "Inner Mongolia",
    "新疆": "Xinjiang",
    "新疆维吾尔自治区": "Xinjiang",
    "宁夏": "Ningxia",
    "宁夏回族自治区": "Ningxia",
    "西藏": "Tibet",
    "西藏自治区": "Tibet",
    "青海": "Qinghai",
    "青海省": "Qinghai",
    "海南": "Hainan",
    "海南省": "Hainan",

    # === 特别行政区 ===
    "香港": "Hong Kong",
    "香港特别行政区": "Hong Kong",
    "澳门": "Macau",
    "澳门特别行政区": "Macau",
    "台湾": "Taiwan",
    "台湾省": "Taiwan",

    # === 主要城市 - 按拼音排序 ===
    # A
    "阿克苏": "Aksu",
    "安庆": "Anqing",
    "安阳": "Anyang",
    "鞍山": "Anshan",

    # B
    "白城": "Baicheng",
    "白山": "Baishan",
    "白银": "Baiyin",
    "百色": "Baise",
    "蚌埠": "Bengbu",
    "包头": "Baotou",
    "宝鸡": "Baoji",
    "保定": "Baoding",
    "保山": "Baoshan",
    "北海": "Beihai",
    "本溪": "Benxi",
    "滨州": "Binzhou",

    # C
    "沧州": "Cangzhou",
    "常德": "Changde",
    "常州": "Changzhou",
    "巢湖": "Chaohu",
    "朝阳": "Chaoyang",
    "潮州": "Chaozhou",
    "郴州": "Chenzhou",
    "成都": "Chengdu",
    "承德": "Chengde",
    "池州": "Chizhou",
    "赤峰": "Chifeng",
    "崇左": "Chongzuo",
    "滁州": "Chuzhou",
    "楚雄": "Chuxiong",

    # D
    "大连": "Dalian",
    "大庆": "Daqing",
    "大同": "Datong",
    "丹东": "Dandong",
    "德阳": "Deyang",
    "德州": "Dezhou",
    "定西": "Dingxi",
    "东莞": "Dongguan",
    "东营": "Dongying",

    # E
    "鄂尔多斯": "Ordos",
    "鄂州": "Ezhou",
    "恩施": "Enshi",

    # F
    "防城港": "Fangchenggang",
    "佛山": "Foshan",
    "抚顺": "Fushun",
    "抚州": "Fuzhou",
    "福州": "Fuzhou",
    "阜阳": "Fuyang",

    # G
    "甘南": "Gannan",
    "赣州": "Ganzhou",
    "固原": "Guyuan",
    "广安": "Guangan",
    "广元": "Guangyuan",
    "广州": "Guangzhou",
    "贵港": "Guigang",
    "贵阳": "Guiyang",
    "桂林": "Guilin",
    "果洛": "Golog",

    # H
    "哈尔滨": "Harbin",
    "海北": "Haibei",
    "海东": "Haidong",
    "海口": "Haikou",
    "海南": "Hainan",
    "海西": "Haixi",
    "邯郸": "Handan",
    "汉中": "Hanzhong",
    "杭州": "Hangzhou",
    "合肥": "Hefei",
    "和田": "Hotan",
    "河池": "Hechi",
    "河源": "Heyuan",
    "菏泽": "Heze",
    "贺州": "Hezhou",
    "鹤壁": "Hebi",
    "鹤岗": "Hegang",
    "黑河": "Heihe",
    "衡水": "Hengshui",
    "衡阳": "Hengyang",
    "红河": "Honghe",
    "呼和浩特": "Hohhot",
    "呼伦贝尔": "Hulunbuir",
    "湖州": "Huzhou",
    "葫芦岛": "Huludao",
    "怀化": "Huaihua",
    "淮安": "Huaian",
    "淮北": "Huaibei",
    "淮南": "Huainan",
    "黄冈": "Huanggang",
    "黄南": "Huangnan",
    "黄山": "Huangshan",
    "黄石": "Huangshi",
    "惠州": "Huizhou",

    # J
    "鸡西": "Jixi",
    "吉安": "Jian",
    "吉林": "Jilin",
    "济南": "Jinan",
    "济宁": "Jining",
    "佳木斯": "Jiamusi",
    "嘉兴": "Jiaxing",
    "嘉峪关": "Jiayuguan",
    "江门": "Jiangmen",
    "焦作": "Jiaozuo",
    "揭阳": "Jieyang",
    "金昌": "Jinchang",
    "金华": "Jinhua",
    "锦州": "Jinzhou",
    "晋城": "Jincheng",
    "晋中": "Jinzhong",
    "荆门": "Jingmen",
    "荆州": "Jingzhou",
    "景德镇": "Jingdezhen",
    "九江": "Jiujiang",
    "酒泉": "Jiuquan",

    # K
    "喀什": "Kashgar",
    "开封": "Kaifeng",
    "克拉玛依": "Karamay",
    "克孜勒苏": "Kizilsu",
    "昆明": "Kunming",
    "昆山": "Kunshan",

    # L
    "拉萨": "Lhasa",
    "来宾": "Laibin",
    "莱芜": "Laiwu",
    "兰州": "Lanzhou",
    "廊坊": "Langfang",
    "乐山": "Leshan",
    "丽江": "Lijiang",
    "丽水": "Lishui",
    "连云港": "Lianyungang",
    "凉山": "Liangshan",
    "辽阳": "Liaoyang",
    "辽源": "Liaoyuan",
    "聊城": "Liaocheng",
    "林芝": "Nyingchi",
    "临沧": "Lincang",
    "临汾": "Linfen",
    "临沂": "Linyi",
    "柳州": "Liuzhou",
    "六安": "Luan",
    "六盘水": "Liupanshui",
    "龙岩": "Longyan",
    "陇南": "Longnan",
    "娄底": "Loudi",
    "泸州": "Luzhou",
    "洛阳": "Luoyang",
    "漯河": "Luohe",
    "吕梁": "Lvliang",

    # M
    "马鞍山": "Maanshan",
    "茂名": "Maoming",
    "眉山": "Meishan",
    "梅州": "Meizhou",
    "绵阳": "Mianyang",
    "牡丹江": "Mudanjiang",

    # N
    "内江": "Neijiang",
    "南昌": "Nanchang",
    "南充": "Nanchong",
    "南京": "Nanjing",
    "南宁": "Nanning",
    "南平": "Nanping",
    "南通": "Nantong",
    "南阳": "Nanyang",
    "那曲": "Nagqu",
    "宁波": "Ningbo",
    "宁德": "Ningde",
    "怒江": "Nujiang",

    # P
    "盘锦": "Panjin",
    "攀枝花": "Panzhihua",
    "平顶山": "Pingdingshan",
    "平凉": "Pingliang",
    "萍乡": "Pingxiang",
    "莆田": "Putian",
    "濮阳": "Puyang",

    # Q
    "七台河": "Qitaihe",
    "齐齐哈尔": "Qiqihar",
    "黔东南": "Qiandongnan",
    "黔南": "Qiannan",
    "黔西南": "Qianxinan",
    "钦州": "Qinzhou",
    "秦皇岛": "Qinhuangdao",
    "青岛": "Qingdao",
    "清远": "Qingyuan",
    "庆阳": "Qingyang",
    "曲靖": "Qujing",
    "衢州": "Quzhou",
    "泉州": "Quanzhou",

    # R
    "日喀则": "Shigatse",
    "日照": "Rizhao",

    # S
    "三门峡": "Sanmenxia",
    "三明": "Sanming",
    "三亚": "Sanya",
    "汕头": "Shantou",
    "汕尾": "Shanwei",
    "商洛": "Shangluo",
    "商丘": "Shangqiu",
    "上饶": "Shangrao",
    "韶关": "Shaoguan",
    "邵阳": "Shaoyang",
    "绍兴": "Shaoxing",
    "深圳": "Shenzhen",
    "沈阳": "Shenyang",
    "十堰": "Shiyan",
    "石家庄": "Shijiazhuang",
    "石嘴山": "Shizuishan",
    "双鸭山": "Shuangyashan",
    "朔州": "Shuozhou",
    "四平": "Siping",
    "松原": "Songyuan",
    "苏州": "Suzhou",
    "宿迁": "Suqian",
    "宿州": "Suzhou",
    "绥化": "Suihua",
    "随州": "Suizhou",
    "遂宁": "Suining",

    # T
    "台州": "Taizhou",
    "太原": "Taiyuan",
    "泰安": "Taian",
    "泰州": "Taizhou",
    "唐山": "Tangshan",
    "天水": "Tianshui",
    "铁岭": "Tieling",
    "通化": "Tonghua",
    "通辽": "Tongliao",
    "铜川": "Tongchuan",
    "铜陵": "Tongling",
    "铜仁": "Tongren",

    # W
    "威海": "Weihai",
    "潍坊": "Weifang",
    "渭南": "Weinan",
    "温州": "Wenzhou",
    "文山": "Wenshan",
    "乌海": "Wuhai",
    "乌兰察布": "Ulanqab",
    "乌鲁木齐": "Urumqi",
    "无锡": "Wuxi",
    "吴忠": "Wuzhong",
    "芜湖": "Wuhu",
    "梧州": "Wuzhou",
    "武汉": "Wuhan",
    "武威": "Wuwei",

    # X
    "西安": "Xian",
    "西宁": "Xining",
    "西双版纳": "Xishuangbanna",
    "锡林郭勒": "Xilingol",
    "厦门": "Xiamen",
    "咸宁": "Xianning",
    "咸阳": "Xianyang",
    "湘潭": "Xiangtan",
    "湘西": "Xiangxi",
    "襄阳": "Xiangyang",
    "孝感": "Xiaogan",
    "忻州": "Xinzhou",
    "新乡": "Xinxiang",
    "新余": "Xinyu",
    "信阳": "Xinyang",
    "兴安": "Xingan",
    "邢台": "Xingtai",
    "徐州": "Xuzhou",
    "许昌": "Xuchang",
    "宣城": "Xuancheng",

    # Y
    "雅安": "Yaan",
    "烟台": "Yantai",
    "延安": "Yanan",
    "延边": "Yanbian",
    "盐城": "Yancheng",
    "扬州": "Yangzhou",
    "阳江": "Yangjiang",
    "阳泉": "Yangquan",
    "伊春": "Yichun",
    "伊犁": "Ili",
    "宜宾": "Yibin",
    "宜昌": "Yichang",
    "宜春": "Yichun",
    "益阳": "Yiyang",
    "银川": "Yinchuan",
    "鹰潭": "Yingtan",
    "营口": "Yingkou",
    "永州": "Yongzhou",
    "榆林": "Yulin",
    "玉林": "Yulin",
    "玉树": "Yushu",
    "玉溪": "Yuxi",
    "岳阳": "Yueyang",
    "云浮": "Yunfu",
    "运城": "Yuncheng",

    # Z
    "枣庄": "Zaozhuang",
    "湛江": "Zhanjiang",
    "张家界": "Zhangjiajie",
    "张家口": "Zhangjiakou",
    "张掖": "Zhangye",
    "漳州": "Zhangzhou",
    "昭通": "Zhaotong",
    "肇庆": "Zhaoqing",
    "镇江": "Zhenjiang",
    "郑州": "Zhengzhou",
    "中山": "Zhongshan",
    "中卫": "Zhongwei",
    "舟山": "Zhoushan",
    "周口": "Zhoukou",
    "珠海": "Zhuhai",
    "株洲": "Zhuzhou",
    "驻马店": "Zhumadian",
    "资阳": "Ziyang",
    "淄博": "Zibo",
    "自贡": "Zigong",
    "遵义": "Zunyi",

    # 台湾主要城市
    "台北": "Taipei",
    "高雄": "Kaohsiung",
    "台中": "Taichung",
    "台南": "Tainan",
    "新北": "New Taipei",
    "基隆": "Keelung",
    "新竹": "Hsinchu",
    "嘉义": "Chiayi",

    # 香港地区
    "香港": "Hong Kong",
    "九龙": "Kowloon",
    "新界": "New Territories",

    # 澳门地区
    "澳门": "Macau",
    "氹仔": "Taipa",
    "路环": "Coloane",

    # === 常见地区和特殊名称 ===
    "珠三角": "Pearl River Delta",
    "长三角": "Yangtze River Delta",
    "京津冀": "Beijing-Tianjin-Hebei",
    "华北": "North China",
    "华东": "East China",
    "华南": "South China",
    "华中": "Central China",
    "西北": "Northwest China",
    "西南": "Southwest China",
    "东北": "Northeast China",

    # === 中国三级行政单位 - 常见县级市、县 ===
    # 安徽
    "天长市": "Tianchang",
    "天长": "Tianchang",
    "明光市": "Mingguang",
    "明光": "Mingguang",
    "界首市": "Jieshou",
    "界首": "Jieshou",
    "宁国市": "Ningguo",
    "宁国": "Ningguo",
    "桐城市": "Tongcheng",
    "桐城": "Tongcheng",
    "巢湖市": "Chaohu",
    "巢湖": "Chaohu",
    "肥西县": "Feixi",
    "肥西": "Feixi",
    "肥东县": "Feidong",
    "肥东": "Feidong",
    "濉溪县": "Suixi",
    "濉溪": "Suixi",
    "砀山县": "Dangshan",
    "砀山": "Dangshan",

    # 福建
    "晋江市": "Jinjiang",
    "晋江": "Jinjiang",
    "南安市": "Nan'an",
    "南安": "Nan'an",
    "石狮市": "Shishi",
    "石狮": "Shishi",
    "福清市": "Fuqing",
    "福清": "Fuqing",
    "漳平市": "Zhangping",
    "漳平": "Zhangping",
    "长乐区": "Changle",
    "长乐": "Changle",
    "长汀县": "Changting",
    "长汀": "Changting",
    "武平县": "Wuping",
    "武平": "Wuping",

    # 甘肃
    "敦煌市": "Dunhuang",
    "敦煌": "Dunhuang",
    "玉门市": "Yumen",
    "玉门": "Yumen",
    "临泽县": "Linze",
    "临泽": "Linze",
    "肃南县": "Sunan",
    "肃南": "Sunan",
    "高台县": "Gaotai",
    "高台": "Gaotai",

    # 广东
    "顺德区": "Shunde",
    "顺德": "Shunde",
    "新会区": "Xinhui",
    "新会": "Xinhui",
    "普宁市": "Puning",
    "普宁": "Puning",
    "陆丰市": "Lufeng",
    "陆丰": "Lufeng",
    "鹤山市": "Heshan",
    "鹤山": "Heshan",
    "四会市": "Sihui",
    "四会": "Sihui",
    "恩平市": "Enping",
    "恩平": "Enping",
    "阳春市": "Yangchun",
    "阳春": "Yangchun",
    "博罗县": "Boluo",
    "博罗": "Boluo",

    # 广西
    "北流市": "Beiliu",
    "北流": "Beiliu",
    "桂平市": "Guiping",
    "桂平": "Guiping",
    "合山市": "Heshan",
    "合山": "Heshan",
    "凭祥市": "Pingxiang",
    "凭祥": "Pingxiang",
    "阳朔县": "Yangshuo",
    "阳朔": "Yangshuo",
    "龙胜县": "Longsheng",
    "龙胜": "Longsheng",

    # 贵州
    "仁怀市": "Renhuai",
    "仁怀": "Renhuai",
    "赤水市": "Chishui",
    "赤水": "Chishui",
    "兴义市": "Xingyi",
    "兴义": "Xingyi",
    "威宁县": "Weining",
    "威宁": "Weining",
    "黔西市": "Qianxi",
    "黔西": "Qianxi",

    # 海南
    "万宁市": "Wanning",
    "万宁": "Wanning",
    "文昌市": "Wenchang",
    "文昌": "Wenchang",
    "琼海市": "Qionghai",
    "琼海": "Qionghai",
    "东方市": "Dongfang",
    "东方": "Dongfang",
    "五指山市": "Wuzhishan",
    "五指山": "Wuzhishan",
    "陵水县": "Lingshui",
    "陵水": "Lingshui",
    "保亭县": "Baoting",
    "保亭": "Baoting",

    # 河北
    "任丘市": "Renqiu",
    "任丘": "Renqiu",
    "霸州市": "Bazhou",
    "霸州": "Bazhou",
    "遵化市": "Zunhua",
    "遵化": "Zunhua",
    "武安市": "Wu'an",
    "武安": "Wu'an",
    "隆尧县": "Longyao",
    "隆尧": "Longyao",

    # 河南
    "邓州市": "Dengzhou",
    "邓州": "Dengzhou",
    "灵宝市": "Lingbao",
    "灵宝": "Lingbao",
    "巩义市": "Gongyi",
    "巩义": "Gongyi",
    "长葛市": "Changge",
    "长葛": "Changge",
    "兰考县": "Lankao",
    "兰考": "Lankao",

    # 黑龙江
    "绥芬河市": "Suifenhe",
    "绥芬河": "Suifenhe",
    "海林市": "Hailin",
    "海林": "Hailin",
    "密山市": "Mishan",
    "密山": "Mishan",
    "东宁县": "Dongning",
    "东宁": "Dongning",
    "五常市": "Wuchang",
    "五常": "Wuchang",

    # 湖北
    "枝江市": "Zhijiang",
    "枝江": "Zhijiang",
    "洪湖市": "Honghu",
    "洪湖": "Honghu",
    "松滋市": "Songzi",
    "松滋": "Songzi",
    "丹江口市": "Danjiangkou",
    "丹江口": "Danjiangkou",
    "竹山县": "Zhushan",
    "竹山": "Zhushan",

    # 湖南
    "浏阳市": "Liuyang",
    "浏阳": "Liuyang",
    "醴陵市": "Liling",
    "醴陵": "Liling",
    "宁乡市": "Ningxiang",
    "宁乡": "Ningxiang",
    "耒阳市": "Leiyang",
    "耒阳": "Leiyang",
    "凤凰县": "Fenghuang",
    "凤凰": "Fenghuang",

    # 吉林
    "梅河口市": "Meihekou",
    "梅河口": "Meihekou",
    "桦甸市": "Huadian",
    "桦甸": "Huadian",
    "珲春市": "Hunchun",
    "珲春": "Hunchun",
    "图们市": "Tumen",
    "图们": "Tumen",
    "辉南县": "Huinan",
    "辉南": "Huinan",

    # 江苏
    "江阴市": "Jiangyin",
    "江阴": "Jiangyin",
    "宜兴市": "Yixing",
    "宜兴": "Yixing",
    "昆山市": "Kunshan",
    "昆山": "Kunshan",
    "泰兴市": "Taixing",
    "泰兴": "Taixing",
    "如皋市": "Rugao",
    "如皋": "Rugao",
    "东海县": "Donghai",
    "东海": "Donghai",

    # 江西
    "贵溪市": "Guixi",
    "贵溪": "Guixi",
    "瑞金市": "Ruijin",
    "瑞金": "Ruijin",
    "樟树市": "Zhangshu",
    "樟树": "Zhangshu",
    "高安市": "Gao'an",
    "高安": "Gao'an",
    "乐安县": "Lean",
    "乐安": "Lean",

    # 辽宁
    "海城市": "Haicheng",
    "海城": "Haicheng",
    "庄河市": "Zhuanghe",
    "庄河": "Zhuanghe",
    "东港市": "Donggang",
    "东港": "Donggang",
    "灯塔市": "Dengta",
    "灯塔": "Dengta",
    "盖州市": "Gaizhou",
    "盖州": "Gaizhou",

    # 内蒙古
    "满洲里市": "Manzhouli",
    "满洲里": "Manzhouli",
    "牙克石市": "Yakeshi",
    "牙克石": "Yakeshi",
    "扎兰屯市": "Zhalantun",
    "扎兰屯": "Zhalantun",
    "二连浩特市": "Erenhot",
    "二连浩特": "Erenhot",
    "杭锦后旗": "Hangjinhou",
    "杭锦后": "Hangjinhou",

    # 宁夏
    "灵武市": "Lingwu",
    "灵武": "Lingwu",
    "青铜峡市": "Qingtongxia",
    "青铜峡": "Qingtongxia",
    "盐池县": "Yanchi",
    "盐池": "Yanchi",

    # 青海
    "德令哈市": "Delingha",
    "德令哈": "Delingha",
    "格尔木市": "Golmud",
    "格尔木": "Golmud",
    "同仁市": "Tongren",
    "同仁": "Tongren",
    "祁连县": "Qilian",
    "祁连": "Qilian",

    # 山东
    "荣成市": "Rongcheng",
    "荣成": "Rongcheng",
    "乳山市": "Rushan",
    "乳山": "Rushan",
    "即墨区": "Jimo",
    "即墨": "Jimo",
    "莱西市": "Laixi",
    "莱西": "Laixi",
    "滕州市": "Tengzhou",
    "滕州": "Tengzhou",
    "邹城市": "Zoucheng",
    "邹城": "Zoucheng",
    "诸城市": "Zhucheng",
    "诸城": "Zhucheng",

    # 山西
    "古交市": "Gujiao",
    "古交": "Gujiao",
    "侯马市": "Houma",
    "侯马": "Houma",
    "永济市": "Yongji",
    "永济": "Yongji",
    "高平市": "Gaoping",
    "高平": "Gaoping",
    "介休市": "Jiexiu",
    "介休": "Jiexiu",

    # 陕西
    "韩城市": "Hancheng",
    "韩城": "Hancheng",
    "华阴市": "Huayin",
    "华阴": "Huayin",
    "兴平市": "Xingping",
    "兴平": "Xingping",
    "神木市": "Shenmu",
    "神木": "Shenmu",
    "府谷县": "Fugu",
    "府谷": "Fugu",

    # 四川
    "都江堰市": "Dujiangyan",
    "都江堰": "Dujiangyan",
    "彭州市": "Pengzhou",
    "彭州": "Pengzhou",
    "乐山市": "Leshan",
    "乐山": "Leshan",
    "崇州市": "Chongzhou",
    "崇州": "Chongzhou",
    "邛崃市": "Qionglai",
    "邛崃": "Qionglai",
    "仁寿县": "Renshou",
    "仁寿": "Renshou",
    "九寨沟县": "Jiuzhaigou",
    "九寨沟": "Jiuzhaigou",

    # 云南
    "丽江市": "Lijiang",
    "丽江": "Lijiang",
    "瑞丽市": "Ruili",
    "瑞丽": "Ruili",
    "香格里拉市": "Shangri-La",
    "香格里拉": "Shangri-La",
    "腾冲市": "Tengchong",
    "腾冲": "Tengchong",
    "建水县": "Jianshui",
    "建水": "Jianshui",

    # 浙江
    "义乌市": "Yiwu",
    "义乌": "Yiwu",
    "诸暨市": "Zhuji",
    "诸暨": "Zhuji",
    "慈溪市": "Cixi",
    "慈溪": "Cixi",
    "玉环市": "Yuhuan",
    "玉环": "Yuhuan",
    "乐清市": "Yueqing",
    "乐清": "Yueqing",

    # 重庆
    "永川区": "Yongchuan",
    "永川": "Yongchuan",
    "合川区": "Hechuan",
    "合川": "Hechuan",
    "江津区": "Jiangjin",
    "江津": "Jiangjin",
    "綦江区": "Qijiang",
    "綦江": "Qijiang",
    "潼南区": "Tongnan",
    "潼南": "Tongnan",

    # 新疆
    "石河子市": "Shihezi",
    "石河子": "Shihezi",
    "阿拉山口市": "Alashankou",
    "阿拉山口": "Alashankou",
    "奎屯市": "Kuitun",
    "奎屯": "Kuitun",
    "五家渠市": "Wujiaqu",
    "五家渠": "Wujiaqu",
    "伊宁县": "Yining County",
    "伊宁": "Yining County",

    # 西藏
    "日喀则市": "Shigatse",
    "日喀则": "Shigatse",
    "昌都市": "Qamdo",
    "昌都": "Qamdo",
    "林芝市": "Nyingchi",
    "林芝": "Nyingchi",
    "江孜县": "Gyantse",
    "江孜": "Gyantse",
    "定日县": "Dingri",
    "定日": "Dingri"
}


def translate_city_name(city_name):
    """
    将中文城市名翻译为英文
    处理省市组合和单独的城市名
    如果找不到映射，返回原始名称
    """
    if not city_name:
        return city_name

    # 检查是否有中文字符
    has_chinese = any('\u4e00' <= char <= '\u9fff' for char in city_name)
    if not has_chinese:
        return city_name

    # 移除空格
    city_name = city_name.replace(' ', '')

    # 1. 查找完全匹配
    if city_name in CHINESE_TO_ENGLISH_CITIES:
        return CHINESE_TO_ENGLISH_CITIES[city_name]

    # 2. 处理"xx省xx市"格式
    for province in ["省", "市", "自治区", "特别行政区"]:
        if province in city_name:
            parts = city_name.split(province)
            # 提取最后一个非空部分作为城市名
            for part in reversed(parts):
                if part and part in CHINESE_TO_ENGLISH_CITIES:
                    return CHINESE_TO_ENGLISH_CITIES[part]

    # 3. 尝试部分匹配
    for cn_name, en_name in sorted(CHINESE_TO_ENGLISH_CITIES.items(),
                                   key=lambda x: len(x[0]),
                                   reverse=True):
        if cn_name in city_name:
            return en_name

    # 没有找到匹配，返回原始名称
    return city_name
