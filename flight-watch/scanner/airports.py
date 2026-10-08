"""City names for common airport codes. Used to name routes, to search the
news for promotions, and to label multi-airport routes."""

CITY = {
    # Taiwan
    "TPE": "台北", "TSA": "台北", "KHH": "高雄", "RMQ": "台中", "TNN": "台南", "KNH": "金門", "MZG": "澎湖",
    # Japan
    "NRT": "東京", "HND": "東京", "KIX": "大阪", "ITM": "大阪", "NGO": "名古屋", "FUK": "福岡", "OKA": "沖繩",
    "CTS": "札幌", "SDJ": "仙台", "HKD": "函館", "KMJ": "熊本", "KOJ": "鹿兒島", "OKJ": "岡山", "TAK": "高松",
    "HIJ": "廣島", "KIJ": "新潟", "SHI": "宮古島", "ISG": "石垣",
    # Korea
    "ICN": "首爾", "GMP": "首爾", "PUS": "釜山", "CJU": "濟州", "TAE": "大邱",
    # Greater China
    "HKG": "香港", "MFM": "澳門", "PVG": "上海", "SHA": "上海", "PEK": "北京", "PKX": "北京",
    # Southeast Asia
    "BKK": "曼谷", "DMK": "曼谷", "CNX": "清邁", "HKT": "普吉", "SGN": "胡志明市", "HAN": "河內", "DAD": "峴港",
    "CXR": "芽莊", "PQC": "富國島", "MNL": "馬尼拉", "CEB": "宿霧", "SIN": "新加坡", "KUL": "吉隆坡",
    "BKI": "亞庇", "PEN": "檳城", "DPS": "峇里島", "CGK": "雅加達", "PNH": "金邊", "REP": "暹粒",
    # Rest of the world
    "LAX": "洛杉磯", "SFO": "舊金山", "SEA": "西雅圖", "JFK": "紐約", "EWR": "紐約", "YVR": "溫哥華",
    "LHR": "倫敦", "LGW": "倫敦", "CDG": "巴黎", "ORY": "巴黎", "AMS": "阿姆斯特丹", "FRA": "法蘭克福",
    "MUC": "慕尼黑", "VIE": "維也納", "PRG": "布拉格", "FCO": "羅馬", "IST": "伊斯坦堡",
    "SYD": "雪梨", "MEL": "墨爾本", "BNE": "布里斯本", "AKL": "奧克蘭",
}


def city(codes):
    """City name for one code or a list of codes, e.g. ["NRT", "HND"] -> "東京"."""
    if isinstance(codes, str):
        codes = [codes]
    names = []
    for c in codes:
        n = CITY.get(c, c)
        if n not in names:
            names.append(n)
    return "/".join(names)
