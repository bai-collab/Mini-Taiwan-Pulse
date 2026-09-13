# Mini Taiwan Pulse — 嘉義聚焦教學版

**用「免金鑰、免綁卡」的開放資料，把嘉義畫成一張會呼吸的互動地圖。**

這是 [Mini Taiwan Pulse](https://github.com/ianlkl11234s/mini-taiwan-pulse) 的嘉義聚焦精簡分支，為國小／國中課程改造：把原本需要付費金鑰或私有圖磚的圖層，全部改接**免金鑰的公開開放資料**，讓任何人 `git clone` 之後只靠免費資源就能把地圖跑起來。

> 基於上游固定 commit `ead13b4`。預設焦點在嘉義市，並非把所有圖層都裁成嘉義（飛機、船、鐵路等仍保留較大脈絡範圍）。

---

## 特色

- **去 Mapbox 化**：底圖改用 [MapLibre GL](https://maplibre.org/) + [CARTO](https://carto.com/) / [OpenFreeMap](https://openfreemap.org/) 免費 GL 樣式 —— 免 token、免註冊、免綁信用卡。
- **水資源家族 + 底圖地形全部接免金鑰真實資料**（取代原本缺檔的私有圖磚）：河川、湖泊、堤防、水庫、流域、灌排渠道、滯洪池、保護區、淹水潛勢、等高線、氣象站。
- **河川水流方向動畫**：沿河道以 marching-ants 虛線流動，讓學生觀察水往哪個方向流。
- **逐層資料狀態徽章**：每個圖層清楚標示「載入中／此視野無資料／資料載入失敗／不支援」，不會靜默空白。
- **航班改接免費 [OpenSky](https://opensky-network.org/)**；時間軸預設「即時＋當下」。

---

## 快速開始

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 3721
```

打開 <http://127.0.0.1:3721/>，左側圖層面板可逐層開關。

### 環境變數（皆為選填）

複製 `.env.example` 成 `.env.local`。**本教學版的免金鑰圖層（水資源、地形、氣象站位置…）不需要任何 key 就能顯示**；下列僅影響「動態即時圖層」：

| 變數 | 用途 | 沒設會怎樣 |
|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | 動態圖層（雨量、水位、公車…）的即時資料來源 | 那些動態層空白，靜態開放資料層照常顯示 |
| `VITE_FLIGHTS_SOURCE=opensky` | 啟用免費 OpenSky 航班 | 不顯示航班 |

> `.env.local` 已在 `.gitignore`，不會被提交。

---

## 免金鑰開放資料來源

| 群組 / 圖層 | 來源 | 格式 / 取得方式 | 金鑰 |
|---|---|---|---|
| 底圖 | CARTO GL + OpenFreeMap + OSM | GL style / raster tiles | 免 |
| 河川、湖泊、灌排渠道、滯洪池 | [OpenStreetMap](https://www.openstreetmap.org/) via [Overpass API](https://overpass-api.de/) | Overpass → GeoJSON | 免 |
| 堤防、流域、水庫（蓄水範圍＋壩體）、水質水量／地下水管制區 | 經濟部水利署 [水利空間資訊服務平台](https://gic.wra.gov.tw/) | KML（WGS84）→ GeoJSON | 免 |
| 淹水潛勢（24hr 650mm） | 水利署 水利空間資訊服務平台 | SHP（TWD97）→ proj4 反投影 → GeoJSON | 免 |
| 等高線（10m／20m） | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)（terrarium 高程磚） | DEM → d3-contour 自算等高線 | 免 |
| 氣象站位置 | 中央氣象署 [CODiS](https://codis.cwa.gov.tw/) `station_list` | GeoJSON（僅測站位置，無即時觀測值） | 免 |
| 航班（選用） | [OpenSky Network](https://opensky-network.org/) | `states/all`（同源代理避 CORS） | 免（匿名有額度） |

> 完整金鑰稽核與各來源限制見上游文件與 `docs/`。氣象站的「即時觀測值」需另申請免費的 CWA 授權碼（本版只做測站位置）。

---

## 資料處理管線（本版新增）

免金鑰資料的抓取／轉換腳本邏輯：

- **OSM**：Overpass query（bbox 嘉義）→ 轉 GeoJSON（way→LineString/Polygon、relation→MultiPolygon）。
- **WRA KML**：`DownLoad.aspx?fname=<圖層>&filetype=KML` → 解 `<description>` 表格欄位映射 popup → 裁嘉義 bbox → Douglas-Peucker 簡化。
- **WRA SHP（淹水潛勢）**：`shapefile` + `proj4` 反投影 TWD97(EPSG:3826)→WGS84 → 裁嘉義。
- **等高線**：terrarium 高程磚解碼 `(R*256+G+B/256)-32768` → 降噪 → `d3-contour` → 像素反投影經緯度。

---

## 技術棧

React 19 · TypeScript · Vite · MapLibre GL · Three.js · Supabase（動態層，選用）

開發規則見 [`CLAUDE.md`](./CLAUDE.md) 與 [`docs/development-rules.md`](./docs/development-rules.md)。

---

## 致謝與授權

本專案衍生自 [Mini Taiwan Pulse（ianlkl11234s）](https://github.com/ianlkl11234s/mini-taiwan-pulse)。開放資料版權分別屬於 OpenStreetMap 貢獻者（ODbL）、經濟部水利署、中央氣象署、國土測繪中心，以及 AWS Terrain Tiles 各來源；使用時請依各自授權標註。
