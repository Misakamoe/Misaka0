# utils/city_mapping.py - 天气查询模块
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
