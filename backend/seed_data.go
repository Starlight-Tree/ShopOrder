package main

// seed_data.go は backend/app/seed_demo.py のデータ（店・メニュー・在庫・宅配）を Go に写したもの（gen_seed_data.py で生成。手で直さない）。

type seedArea struct {
	code int
	name string
	sort int
}

var seedAreas = []seedArea{
	{1, "居住区", 1},
	{2, "発着場", 2},
	{3, "岩山", 3},
	{4, "遺跡", 4},
}

type seedStore struct {
	code, name          string
	area                int
	address             string
	openTime, closeTime string
	closedWeekday       *int
	lastOrderMinutes    int
	mobileOrder         bool
	seats               int
}

var seedStores = []seedStore{
	{"residential-main", "居住区本店", 1, "アルカ市居住区1-4-2", "07:00:00", "21:00:00", nil, 30, true, 68},
	{"residential-dome", "居住区ドーム店", 1, "アルカ市居住区3-8-11", "08:00:00", "20:00:00", ptr(3), 30, true, 42},
	{"residential-market", "居住区市場前店", 1, "アルカ市居住区5-2-6", "06:30:00", "18:00:00", ptr(7), 30, true, 30},
	{"residential-signal", "居住区信号塔店", 1, "アルカ市居住区7-1-9", "09:00:00", "19:00:00", ptr(2), 30, false, 24},
	{"terminal-central", "発着場中央店", 2, "アルカ市発着場2-1-5", "07:00:00", "22:00:00", nil, 30, true, 54},
	{"terminal-west", "発着場西口店", 2, "アルカ市発着場4-6-3", "07:30:00", "21:00:00", nil, 30, true, 36},
	{"terminal-east", "発着場東口店", 2, "アルカ市発着場6-3-8", "08:00:00", "21:00:00", ptr(1), 30, true, 40},
	{"rock-plaza", "岩山広場店", 3, "アルカ市岩山2-5-1", "09:00:00", "18:00:00", ptr(4), 30, true, 48},
	{"rock-school", "岩山学園前店", 3, "アルカ市岩山5-7-4", "08:00:00", "19:00:00", ptr(7), 30, true, 32},
	{"rock-lookout", "岩山展望店", 3, "アルカ市岩山8-2-10", "10:00:00", "18:00:00", ptr(3), 30, true, 28},
	{"ruins-terrace", "遺跡テラス店", 4, "アルカ市遺跡1-3-7", "09:00:00", "20:00:00", nil, 30, true, 76},
	{"ruins-hut", "遺跡発掘小屋店", 4, "アルカ市遺跡3-9-2", "10:00:00", "17:00:00", ptr(2), 15, true, 20},
}

type seedVariant struct {
	size, temperature string
	price             int
}

type seedMenuItem struct {
	code, name, category, description string
	allergens                         []string
	seasonFrom, seasonTo              *string
	soldFrom, soldUntil               *string
	variants                          []seedVariant
}

var seedMenu = []seedMenuItem{
	{"oasis-blend", "オアシスブレンド", "drink", "深煎りの豆を 3 種類ブレンドした、オアシス珈琲の看板。豆は 3 つの栽培ドーム産で、居住区の自社工房で焙煎します。", []string{}, nil, nil, nil, nil, []seedVariant{{"S", "hot", 380}, {"S", "ice", 380}, {"M", "hot", 450}, {"M", "ice", 450}, {"L", "hot", 520}, {"L", "ice", 520}}},
	{"seasonal-blend", "季節のブレンド", "drink", "3 か月ごと、年 4 回入れ替わるブレンド。", []string{}, nil, nil, nil, nil, []seedVariant{{"M", "hot", 480}, {"M", "ice", 480}}},
	{"kikan-limited", "帰還祭の限定ドリンク", "drink", "帰還祭（12/1〜12/25）だけの限定ドリンク。数がなくなり次第、その日の販売は終了します。", []string{}, ptr("12-01"), ptr("12-25"), nil, nil, []seedVariant{{"M", "hot", 550}, {"M", "ice", 550}}},
	{"cafe-latte", "カフェラテ", "drink", "ミルクとコーヒーのバランスのドリンク。", []string{"乳"}, nil, nil, nil, nil, []seedVariant{{"M", "hot", 500}, {"M", "ice", 500}, {"L", "hot", 570}, {"L", "ice", 570}}},
	{"americano", "アメリカーノ", "drink", "すっきりとした一杯。", []string{}, nil, nil, nil, nil, []seedVariant{{"S", "hot", 340}, {"S", "ice", 340}, {"M", "hot", 400}, {"M", "ice", 400}, {"L", "hot", 460}, {"L", "ice", 460}}},
	{"cappuccino", "カプチーノ", "drink", "ふわりとしたミルクの泡を重ねた一杯。", []string{"乳"}, nil, nil, nil, nil, []seedVariant{{"S", "hot", 380}, {"S", "ice", 380}, {"M", "hot", 440}, {"M", "ice", 440}, {"L", "hot", 500}, {"L", "ice", 500}}},
	{"matcha-latte", "抹茶ラテ", "drink", "抹茶とミルクのドリンク。アイスは 20 ルミ増し。", []string{"乳"}, nil, nil, nil, nil, []seedVariant{{"S", "hot", 420}, {"S", "ice", 440}, {"M", "hot", 480}, {"M", "ice", 500}, {"L", "hot", 540}, {"L", "ice", 560}}},
	{"black-tea", "紅茶", "drink", "すっきりとした香りの紅茶。", []string{}, nil, nil, nil, nil, []seedVariant{{"S", "hot", 300}, {"S", "ice", 300}, {"M", "hot", 360}, {"M", "ice", 360}, {"L", "hot", 420}, {"L", "ice", 420}}},
	{"hot-sandwich", "ホットサンド", "food", "焼きたてのホットサンド。", []string{"乳", "小麦"}, nil, nil, nil, nil, []seedVariant{{"-", "-", 520}}},
	{"meat-pie", "ミートパイ", "food", "11:00 から。", []string{"卵", "乳", "小麦"}, nil, nil, ptr("11:00:00"), nil, []seedVariant{{"-", "-", 480}}},
	{"cheesecake", "チーズケーキ", "food", "しっとりとしたチーズケーキ。", []string{"卵", "乳", "小麦"}, nil, nil, nil, nil, []seedVariant{{"-", "-", 450}}},
	{"gateau-chocolat", "ガトーショコラ", "food", "濃厚なガトーショコラ。", []string{"卵", "乳", "小麦", "くるみ"}, nil, nil, nil, nil, []seedVariant{{"-", "-", 460}}},
	{"morning-set", "モーニングセット", "food", "オアシスブレンド（S）とトースト。7:00〜10:30。", []string{"乳", "小麦"}, nil, nil, ptr("07:00:00"), ptr("10:30:00"), []seedVariant{{"-", "-", 600}}},
	{"beans-oasis", "オアシスブレンドの豆（200 g）", "beans", "自社工房で焙煎した豆。", []string{}, nil, nil, nil, nil, []seedVariant{{"-", "-", 1800}}},
	{"beans-seasonal", "季節のブレンドの豆（200 g）", "beans", "自社工房で焙煎した、季節のブレンドの豆。", []string{}, nil, nil, nil, nil, []seedVariant{{"-", "-", 1900}}},
}

type seedStockItem struct {
	code, name, kind, unit             string
	reorderPoint, safetyStock, baseQty int
}

var seedStockItems = []seedStockItem{
	{"coffee-beans", "コーヒー豆", "material", "g", 2000, 500, 12000},
	{"milk", "牛乳", "material", "ml", 4000, 1000, 20000},
	{"matcha", "抹茶", "material", "g", 150, 50, 800},
	{"tea-leaves", "紅茶葉", "material", "g", 150, 50, 900},
	{"cup-s", "カップ S", "material", "個", 40, 10, 200},
	{"cup-m", "カップ M", "material", "個", 60, 10, 300},
	{"cup-l", "カップ L", "material", "個", 40, 10, 200},
	{"bread", "パン", "material", "個", 15, 5, 60},
	{"hot-sandwich", "ホットサンド", "sellable", "個", 6, 0, 30},
	{"meat-pie", "ミートパイ", "sellable", "個", 6, 0, 24},
	{"cheesecake", "チーズケーキ", "sellable", "個", 6, 0, 24},
	{"gateau-chocolat", "ガトーショコラ", "sellable", "個", 5, 0, 20},
	{"beans-bag-oasis", "オアシスブレンドの豆（200 g）", "sellable", "袋", 8, 0, 40},
	{"beans-bag-seasonal", "季節のブレンドの豆（200 g）", "sellable", "袋", 6, 0, 30},
}

var seedLowStock = map[[2]string]int{
	{"terminal-west", "gateau-chocolat"}: 3,
}

type seedZone struct {
	area                                 int
	name                                 string
	fee, freeOver, minOrder, baseMinutes int
}

var seedZones = []seedZone{
	{1, "居住区", 150, 2000, 600, 25},
	{2, "発着場", 200, 2000, 700, 30},
	{3, "岩山", 300, 2000, 800, 40},
	{4, "遺跡", 400, 2000, 900, 50},
}

var seedZoneTravel = [][3]int{
	{1, 2, 10},
	{2, 3, 15},
	{3, 4, 15},
	{1, 3, 20},
	{2, 4, 25},
	{1, 4, 30},
}

type seedCourier struct{ storeCode, name string }

var seedCouriers = []seedCourier{
	{"residential-main", "ラシード"},
	{"residential-main", "ナディア"},
	{"residential-dome", "カミル"},
	{"terminal-central", "ヤスミン"},
	{"terminal-central", "ハリド"},
	{"terminal-west", "サーラ"},
	{"rock-plaza", "イドリス"},
	{"ruins-terrace", "ライラ"},
}
