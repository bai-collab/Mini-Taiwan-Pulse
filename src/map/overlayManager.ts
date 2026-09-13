import type { Map as MaplibreMap } from "maplibre-gl";
import type { OverlayConfig, LayerVisibility } from "../types";
import {
  diffPaint,
  snapshotPaint,
  paintSnapshotEquals,
  type SerializedPaint,
} from "./overlayPaintDiff";
import { pmtilesUrl } from "./pmtilesSourceType";
import { loadingRegistry } from "../lib/loadingRegistry";
import { layerDataStatusStore } from "../state/layerDataStatusStore";
import { LAYER_LABELS } from "../components/sidebar/layerCatalog";
import { resolvePropertyValueScale } from "../data/propertyValueTypes";
import { resolveCompanyGridScale } from "../data/businessRegistryTypes";

/**
 * 主站與 `/embed` 都使用 MapLibre，這裡只保留兩者共用的地圖操作介面。
 */
/*
 * 刻意用結構介面，避免 MapLibre 各版本的泛型簽名讓每個呼叫點都變成 union 錯誤。
 * 這裡只宣告本模組實際用到的方法，參數型別放寬到
 * any 是這層 adapter 的代價，真正的型別安全由 overlayRegistry 的 OverlayConfig 把關。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OverlayMap {
  getSource(id: string): any;
  addSource(id: string, source: any): void;
  getLayer(id: string): any;
  addLayer(layer: any, before?: string): void;
  removeLayer(id: string): void;
  getLayoutProperty(id: string, name: string): any;
  setLayoutProperty(id: string, name: string, value: any): void;
  setPaintProperty(id: string, name: string, value: any): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// MapLibre Map 必須滿足上面的結構 —— 引擎簽名改變時在此集中暴露。
const _maplibreSatisfies: (m: MaplibreMap) => OverlayMap = (m) => m;
void _maplibreSatisfies;

/** 保留注入點，讓 embed 可沿用同一套 overlay mount 流程。 */
export interface OverlayEngineOptions {
  /** 產生 PMTiles source 規格；預設為 MapLibre vector/raster + pmtiles:// */
  pmtilesSource?: (config: OverlayConfig) => Record<string, unknown>;
}

function defaultPmtilesSource(config: OverlayConfig): Record<string, unknown> {
  const isRaster = !config.pmtiles?.sourceLayer;
  return {
    type: isRaster ? "raster" : "vector",
    url: pmtilesUrl(config.sourceUrl),
    minzoom: config.pmtiles?.minzoom,
    maxzoom: config.pmtiles?.maxzoom,
    ...(isRaster ? { tileSize: 512 } : {}),
  };
}

function layerId(config: OverlayConfig, suffix: string) {
  return `${config.sourceId}-${suffix}`;
}

/**
 * Layer-level opacity 的共通乘數。個別 paint 保留自己的資料／深淺色 alpha，
 * 使用者明確登記的 `opacityParam` 乘在最外層，沒有登記時維持原 paint。
 */
export function applyLayerOpacity(
  config: OverlayConfig,
  paint: Record<string, unknown>,
  params?: Record<string, number>,
): Record<string, unknown> {
  if (!config.opacityParam) return paint;
  const opacity = params?.[config.opacityParam];
  if (opacity === undefined) return paint;

  const out = { ...paint };
  for (const [key, value] of Object.entries(out)) {
    if (!key.endsWith("-opacity") || value === undefined) continue;
    out[key] = typeof value === "number" ? value * opacity : ["*", value, opacity];
  }
  return out;
}

/**
 * MapLibre 5 沒有 Mapbox 的 raster-color shader properties。保留 raster tile
 * 的 opacity/resampling，移除這三個選配欄位，讓熱島／樹冠影像仍能作為普通
 * 2D raster overlay 顯示，而不會因 addLayer 被 style validator 整層拒收。
 */
export function normalizePaintForMapLibre(
  layerType: OverlayConfig["layers"][number]["type"],
  paint: Record<string, unknown>,
): Record<string, unknown> {
  if (layerType !== "raster") return paint;
  const normalized = { ...paint };
  delete normalized["raster-color"];
  delete normalized["raster-color-mix"];
  delete normalized["raster-color-range"];
  return normalized;
}

/**
 * 該 config 當下該不該可見 = 圖層 toggle 開啟 **且**（多尺度圖層）目前選的尺度就是它。
 *
 * `propertyValueGrid` 與 `companyCapitalGrid` 都是「一個 layer key ↔ 多個
 * source」的圖層；尺度是**手動選擇**、不隨 zoom 自動切換。
 * 用 `layout.visibility` 而非 opacity 0 隱藏未選中的尺度 —— opacity 0 的 layer
 * 仍會下載圖磚（三尺度合計 110MB），visibility:none 才會讓 Mapbox 完全跳過該 source。
 *
 * ⚠️ 呼叫端若在 params 變動時也要重算可見性，記得把 scaleIdx 放進 effect deps
 *    （可見性 effect 預設只吃 layerVisibility）。
 */
export function isOverlayVisible(
  config: OverlayConfig,
  visibility: LayerVisibility,
  params?: Record<string, number>,
): boolean {
  if (!visibility[config.id]) return false;
  if (config.id === "propertyValueGrid") {
    return config.sourceId === resolvePropertyValueScale(params?.propertyValueGridScaleIdx ?? 0).sourceId;
  }
  if (config.id === "companyCapitalGrid") {
    return config.sourceId === resolveCompanyGridScale(params?.companyGridScaleIdx ?? 0).sourceId;
  }
  return true;
}

/**
 * 解出 spec.filter 的當下值：函式形式（buildingsGba 高度門檻篩選首用）要餵目前 params 求值，
 * 純陣列形式直接回傳。filter 不像 paint 有 setFilter 式 diff API 可用 → 只能靠
 * rebuildOnParamChange 整層 remove/addLayer 帶新值重建（見 updateOverlayTheme）。
 */
function resolveFilter(
  spec: OverlayConfig["layers"][number],
  params?: Record<string, number>,
): unknown[] | undefined {
  return typeof spec.filter === "function" ? spec.filter(params) : spec.filter;
}

// 每個 map instance 一份「上次套用的 paint 快照」（layer id → serialized paint）。
// style 切換時 layer 會被清掉重建，addOverlay 會重設對應快照，所以不會殘留髒值。
const paintCacheByMap = new WeakMap<OverlayMap, Map<string, SerializedPaint>>();

function paintCacheOf(map: OverlayMap): Map<string, SerializedPaint> {
  let cache = paintCacheByMap.get(map);
  if (!cache) {
    cache = new Map();
    paintCacheByMap.set(map, cache);
  }
  return cache;
}

/**
 * GeoJSON source 效能參數。
 * - tolerance：Douglas-Peucker 簡化容差（tile px）。預設 0.375 幾乎不簡化；
 *   1.2px 誤差在任何 zoom 下肉眼不可見，但 line/polygon 頂點數可降數倍。
 * - buffer：tile 邊緣緩衝（px）。預設 128 對純 line/fill 過大；64 已足夠
 *   line join 連續。有 circle/symbol 的 source 維持 128，避免大半徑點在
 *   tile 邊緣被裁切。
 */
export function geojsonSourceOptions(config: OverlayConfig): {
  tolerance: number;
  buffer: number;
} {
  const hasPointLayers = config.layers.some((s) => s.type === "circle");
  return {
    tolerance: 1.2,
    buffer: hasPointLayers ? 128 : 64,
  };
}

/** 新增單一 overlay（source + 所有 layers） */
export function addOverlay(
  map: OverlayMap,
  config: OverlayConfig,
  isDark: boolean,
  params?: Record<string, number>,
  opts?: OverlayEngineOptions,
) {
  if (!map.getSource(config.sourceId)) {
    if (config.pmtiles) {
      // PMTiles 走 MapLibre protocol；MapView 建立 source 前已完成一次註冊。
      const source = (opts?.pmtilesSource ?? defaultPmtilesSource)(config);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.addSource(config.sourceId, source as any);
      if (config.attribution) {
        // PMTiles metadata 未帶 attribution 時，直接在 source instance 補上，
        // 讓 AttributionControl 仍能顯示 registry 的來源說明。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const src = map.getSource(config.sourceId) as any;
        if (src) {
          src.attribution = config.attribution;
          src.on?.("data", () => {
            if (src.attribution !== config.attribution) src.attribution = config.attribution;
          });
        }
      }
    } else {
      // 全部用空 FC 起手，避免 mount 時 Mapbox 自動 fetch sourceUrl。
      // 靜態 GeoJSON 改由 hydrateOverlayIfNeeded（toggle on 觸發）setData。
      // dynamicData：由對應 loader/hook 按日 setData 餵入。
      // attribution：帶上後由地圖引擎內建的 AttributionControl 自動彙整顯示。
      map.addSource(config.sourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection,
        // ⚠️ 只在有值時才帶這個鍵，不可寫成 `attribution: config.attribution`：
        // Mapbox 的 style 驗證對 `attribution: undefined` 會直接判 fail
        // （`sources.<id>.attribution: string expected, undefined found`），
        // **整個 source 不會被建立**，接著該 overlay 的每一層都會噴
        // `layers.<id>: source "<id>" not found`。
        // 實測（2026-08-22，`map.addSource` 探針）：帶 undefined → NOT added；
        // 不帶這個鍵 → added。registry 裡絕大多數 overlay 都沒有 attribution。
        ...(config.attribution ? { attribution: config.attribution } : {}),
        ...geojsonSourceOptions(config),
      });
    }
  }

  const cache = paintCacheOf(map);
  for (const spec of config.layers) {
    const id = layerId(config, spec.suffix);
    if (map.getLayer(id)) continue;

    const paint = normalizePaintForMapLibre(spec.type, applyLayerOpacity(config, spec.paint(isDark, params), params));
    const filter = resolveFilter(spec, params);
    map.addLayer({
      id,
      type: spec.type as "line",  // TS union trick
      source: config.sourceId,
      // raster PMTiles 無 sourceLayer（raster layer 不允許 source-layer 屬性）
      ...(config.pmtiles?.sourceLayer ? { "source-layer": config.pmtiles.sourceLayer } : {}),
      ...(spec.layout
          ? { layout: typeof spec.layout === "function" ? spec.layout(isDark, params) : spec.layout }
          : {}),
      ...(spec.minzoom != null ? { minzoom: spec.minzoom } : {}),
      ...(spec.maxzoom != null ? { maxzoom: spec.maxzoom } : {}),
      ...(filter ? { filter } : config.filter ? { filter: config.filter } : {}),
      paint: paint as Record<string, unknown>,
    } as any);
    // __filter 併入快照僅供 rebuild 變更偵測比對用，不會送進 MapLibre。
    cache.set(id, snapshotPaint({ ...paint, ...(filter ? { __filter: filter } : {}) }));
  }
}

/** 更新單一 overlay 主題（深淺色 + params）— diff 式，只動真正改變的 paint key */
export function updateOverlayTheme(
  map: OverlayMap,
  config: OverlayConfig,
  isDark: boolean,
  params?: Record<string, number>,
  overlayVisible = true,
) {
  if (!map.getSource(config.sourceId)) return;

  const cache = paintCacheOf(map);

  // 需要 rebuild 的 layers（如 station points 的 circle-radius）
  if (config.rebuildOnParamChange) {
    // 先比對 paint 是否真的變了；沒變就完全不 rebuild（避免 slider 拖動時整層重建）
    let needRebuild = false;
    const nextSnapshots = new Map<string, SerializedPaint>();
    for (const spec of config.layers) {
      if (!config.rebuildOnParamChange.includes(spec.suffix)) continue;
      const id = layerId(config, spec.suffix);
      // 把 paint + (callback) layout + (函式) filter 一起 snapshot；三者任一變化都需 trigger rebuild
      // （filter 併入 __filter 合成 key 僅供比對，不是真的 mapbox paint property）
      const paintObj = normalizePaintForMapLibre(spec.type, applyLayerOpacity(config, spec.paint(isDark, params), params));
      const layoutObj = typeof spec.layout === "function" ? spec.layout(isDark, params) : (spec.layout ?? {});
      const filterObj = resolveFilter(spec, params);
      const snapshot = snapshotPaint({ ...paintObj, ...layoutObj, ...(filterObj ? { __filter: filterObj } : {}) });
      nextSnapshots.set(id, snapshot);
      if (!map.getLayer(id) || !paintSnapshotEquals(cache.get(id), snapshot)) {
        needRebuild = true;
      }
    }

    if (needRebuild) {
      // 記住目前 visibility 狀態
      let wasHidden = false;
      for (const suffix of config.rebuildOnParamChange) {
        const id = layerId(config, suffix);
        if (map.getLayer(id)) {
          if (map.getLayoutProperty(id, "visibility") === "none") wasHidden = true;
          map.removeLayer(id);
        }
      }
      for (const spec of config.layers) {
        if (!config.rebuildOnParamChange.includes(spec.suffix)) continue;
        const id = layerId(config, spec.suffix);
        if (map.getLayer(id)) continue;
        const paint = normalizePaintForMapLibre(spec.type, applyLayerOpacity(config, spec.paint(isDark, params), params));
        const layoutObj = typeof spec.layout === "function" ? spec.layout(isDark, params) : spec.layout;
        const filter = resolveFilter(spec, params);
        map.addLayer({
          id,
          type: spec.type as "line",
          source: config.sourceId,
          ...(config.pmtiles?.sourceLayer ? { "source-layer": config.pmtiles.sourceLayer } : {}),
          ...(layoutObj ? { layout: layoutObj } : {}),
          ...(spec.minzoom != null ? { minzoom: spec.minzoom } : {}),
          ...(spec.maxzoom != null ? { maxzoom: spec.maxzoom } : {}),
          ...(filter ? { filter } : config.filter ? { filter: config.filter } : {}),
          paint: paint as Record<string, unknown>,
        } as any);
        cache.set(id, nextSnapshots.get(id) ?? snapshotPaint(paint));
      }
      // 還原 visibility 狀態
      if (wasHidden) {
        for (const suffix of config.rebuildOnParamChange) {
          const id = layerId(config, suffix);
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        }
      }
    }

    // 非 rebuild layers 仍走 diff 式 setPaintProperty
    for (const spec of config.layers) {
      if (config.rebuildOnParamChange.includes(spec.suffix)) continue;
      applyPaintDiff(map, cache, layerId(config, spec.suffix), normalizePaintForMapLibre(spec.type, applyLayerOpacity(config, spec.paint(isDark, params), params)));
      if (typeof spec.layout === "function") {
        const layout = spec.layout(isDark, params);
        applyLayoutDiff(map, layerId(config, spec.suffix), overlayVisible ? layout : { ...layout, visibility: "none" });
      }
    }
    return;
  }

  // 一般 layers: diff 式 setPaintProperty + callback layout 也 diff 更新
  for (const spec of config.layers) {
    applyPaintDiff(map, cache, layerId(config, spec.suffix), normalizePaintForMapLibre(spec.type, applyLayerOpacity(config, spec.paint(isDark, params), params)));
    if (typeof spec.layout === "function") {
      const layout = spec.layout(isDark, params);
      applyLayoutDiff(map, layerId(config, spec.suffix), overlayVisible ? layout : { ...layout, visibility: "none" });
    }
  }
}

const layoutCacheByMap = new WeakMap<OverlayMap, Map<string, Record<string, string>>>();
function layoutCacheOf(map: OverlayMap): Map<string, Record<string, string>> {
  let cache = layoutCacheByMap.get(map);
  if (!cache) {
    cache = new Map();
    layoutCacheByMap.set(map, cache);
  }
  return cache;
}

function applyLayoutDiff(
  map: OverlayMap,
  id: string,
  layout: Record<string, unknown>,
) {
  if (!map.getLayer(id)) return;
  const cache = layoutCacheOf(map);
  const prev = cache.get(id) ?? {};
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(layout)) {
    const s = JSON.stringify(v) ?? "__undefined__";
    next[k] = s;
    if (prev[k] !== s) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setLayoutProperty(id, k as any, v as any);
      } catch (e) {
        console.warn(`[overlayManager] setLayoutProperty ${id}/${k} failed`, e);
      }
    }
  }
  cache.set(id, next);
}

function applyPaintDiff(
  map: OverlayMap,
  cache: Map<string, SerializedPaint>,
  id: string,
  paint: Record<string, unknown>,
) {
  if (!map.getLayer(id)) return;
  const { changed, serialized } = diffPaint(cache.get(id), paint);
  // 無快照（理論上 addOverlay 都會建立）→ 保守全套用
  for (const [key, value] of changed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.setPaintProperty(id, key as any, value);
  }
  cache.set(id, serialized);
}

// ── Static GeoJSON lazy hydration ──
// 全域單例：紀錄哪些 sourceId 已經 hydrate（fetch + setData）過，避免重抓。
// key 用 sourceId（不是 config.id），自然處理「多個 overlay 共用同一 sourceUrl」。
const hydratedSources = new Set<string>();

function ringCentroid(ring: GeoJSON.Position[]): [number, number] | null {
  if (ring.length < 3) return null;
  let area2 = 0;
  let xSum = 0;
  let ySum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const ax = Number(a[0]);
    const ay = Number(a[1]);
    const bx = Number(b[0]);
    const by = Number(b[1]);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    const cross = ax * by - bx * ay;
    area2 += cross;
    xSum += (ax + bx) * cross;
    ySum += (ay + by) * cross;
  }
  if (Math.abs(area2) > 1e-12) return [xSum / (3 * area2), ySum / (3 * area2)];

  const valid = ring
    .map((position) => [Number(position[0]), Number(position[1])] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (valid.length === 0) return null;
  return [
    valid.reduce((sum, [x]) => sum + x, 0) / valid.length,
    valid.reduce((sum, [, y]) => sum + y, 0) / valid.length,
  ];
}

function ringArea2(ring: GeoJSON.Position[]): number {
  let area2 = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    area2 += Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1]);
  }
  return Number.isFinite(area2) ? Math.abs(area2) : 0;
}

/**
 * Polygon / MultiPolygon 的主外環面心。MultiPolygon 取面積最大的部件，
 * 避免機場離島或碎面把點位拉到幾何之間的空白區。
 */
function polygonCentroid(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] | null {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const largest = polygons
    .map((polygon) => ({ ring: polygon[0] ?? [], area: ringArea2(polygon[0] ?? []) }))
    .sort((a, b) => b.area - a.area)[0];
  return largest ? ringCentroid(largest.ring) : null;
}

/** 保留 feature id / properties，只轉換可驗證的面幾何；其他類型不猜測也不補零。 */
export function polygonFeaturesToCentroids(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const feature of data.features) {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) continue;
    const coordinates = polygonCentroid(geometry);
    if (!coordinates) continue;
    features.push({
      type: "Feature",
      ...(feature.id !== undefined ? { id: feature.id } : {}),
      geometry: { type: "Point", coordinates },
      properties: feature.properties,
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * 若 config 是靜態 GeoJSON 且尚未 hydrate → fetch sourceUrl + setData。
 * dynamicData / pmtiles 配置直接 no-op（pmtiles 由 Mapbox 自動 lazy load tile，
 * dynamicData 由各自 loader 負責）。
 *
 * 設計：
 * - 失敗時清掉 set 讓下次 toggle 可重試
 * - 先標記 hydrated 防同一 toggle 內重複觸發 race
 */
export async function hydrateOverlayIfNeeded(
  map: OverlayMap,
  config: OverlayConfig,
): Promise<void> {
  if (config.pmtiles || config.dynamicData) return;
  if (hydratedSources.has(config.sourceId)) return;
  hydratedSources.add(config.sourceId);
  const taskId = `overlay-hydrate:${config.sourceId}`;
  const label = LAYER_LABELS[config.id] ?? config.sourceId;
  loadingRegistry.start(taskId, label);
  try {
    const res = await fetch(config.sourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as GeoJSON.FeatureCollection;
    const json = config.geojsonTransform === "centroid"
      ? polygonFeaturesToCentroids(raw)
      : raw;
    const src = map.getSource(config.sourceId);
    if (src && "setData" in src) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (src as any).setData(json);
    }
    // 逐層資料狀態：載到但 0 筆 → empty；有 feature → ready。
    layerDataStatusStore.set(config.id, (json.features?.length ?? 0) > 0 ? "ready" : "empty");
  } catch (e) {
    hydratedSources.delete(config.sourceId);
    // fetch 失敗 / 404（多為本機缺該 geojson 資產）→ 標載入失敗，讓側欄徽章說清楚原因。
    layerDataStatusStore.set(config.id, "error");
    console.warn(`[overlay] hydrate ${config.sourceId} failed:`, e);
  } finally {
    loadingRegistry.end(taskId);
  }
}

/** 底圖切換（style.load）後 overlay source 會被 Mapbox 重建為空 FC → 清 hydrate 記錄，
 *  讓可見的靜態 GeoJSON 圖層可重新 fetch + setData（否則切底圖後圖層變空白）。 */
export function resetOverlayHydration(): void {
  hydratedSources.clear();
}

/** 設定單一 overlay 可見性 */
export function setOverlayVisible(
  map: OverlayMap,
  config: OverlayConfig,
  visible: boolean,
  isDark = false,
  params?: Record<string, number>,
  opts?: OverlayEngineOptions,
) {
  // Lazy：轉為可見時，若 source/layer 尚未建立就先建（預設不載、使用者點開才載）。
  // 這讓啟動時不會為隱藏層建立 PMTiles source（避免缺資產 404 讓地圖永不 idle）。
  if (visible) {
    const firstId = layerId(config, config.layers[0]?.suffix ?? "");
    if (!map.getLayer(firstId)) {
      addOverlay(map, config, isDark, params, opts);
    }
  }
  for (const spec of config.layers) {
    const id = layerId(config, spec.suffix);
    if (map.getLayer(id)) {
      const resolvedLayout = typeof spec.layout === "function"
        ? spec.layout(isDark, params)
        : spec.layout;
      const modeAllows = resolvedLayout?.visibility !== "none";
      const v = visible && modeAllows ? "visible" : "none";
      map.setLayoutProperty(id, "visibility", v);
    }
  }
}

/** 批量新增所有 overlays + 設定初始可見性 */
export function addAllOverlays(
  map: OverlayMap,
  registry: OverlayConfig[],
  isDark: boolean,
  visibility: LayerVisibility,
  params?: Record<string, number>,
  opts?: OverlayEngineOptions,
) {
  for (const config of registry) {
    // Lazy：只建立目前可見的 overlay；隱藏層等使用者點開，再由 setOverlayVisible 建立。
    if (!isOverlayVisible(config, visibility, params)) continue;
    addOverlay(map, config, isDark, params, opts);
  }
}

/** 批量更新所有 overlay 主題 */
export function updateAllOverlayThemes(
  map: OverlayMap,
  registry: OverlayConfig[],
  isDark: boolean,
  params?: Record<string, number>,
  visibility?: LayerVisibility,
) {
  for (const config of registry) {
    updateOverlayTheme(
      map,
      config,
      isDark,
      params,
      visibility ? isOverlayVisible(config, visibility, params) : true,
    );
  }
}
