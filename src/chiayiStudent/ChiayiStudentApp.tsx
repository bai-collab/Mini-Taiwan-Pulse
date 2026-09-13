import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { registerPmtilesProtocolOnce } from "../embed/maplibreAdapters";
import {
  levelFromChar,
  ROAD_CONGESTION_COLORS,
} from "../data/roadCongestionLoader";
import {
  buildWeatherQueryPoints,
  fetchChiayiBoundary,
  getBoundaryPositions,
} from "./chiayiBoundary";
import {
  fetchChiayiWeatherForecast,
  resolveWeatherDisplayState,
  type WeatherForecastData,
  type WeatherHourlyValue,
} from "./weatherForecast";
import {
  busPositionsAtTime,
  fetchChiayiPublicTransportWeekData,
  fetchChiayiTrafficWeekData,
  fetchChiayiWaterWeekData,
  taiwanDateKey,
  trafficDayAtTime,
  trafficSlotAtTimestamp,
  trafficSlotTimestamp,
  waterFrameAtTime,
  weekCursorMax,
  weekCursorTimestamp,
  type ChiayiBusPoint,
  type ChiayiBusRouteFeature,
  type ChiayiPublicTransportWeekData,
  type ChiayiTopicId,
  type ChiayiTrafficData,
  type ChiayiTrafficWeekData,
  type ChiayiWaterFrame,
  type ChiayiWaterWeekData,
} from "./liveTopics";
import {
  createChiayiBus3dController,
  type ChiayiBus3dController,
} from "./chiayiBus3dLayer";

const CHIAYI_CENTER: [number, number] = [120.45, 23.48];
const BOUNDARY_SOURCE_ID = "chiayi-student-boundary";
const WEATHER_SOURCE_ID = "chiayi-student-weather";
const WEATHER_LAYER_ID = "chiayi-student-weather-points";
const WATER_SOURCE_ID = "chiayi-student-water";
const WATER_LAYER_ID = "chiayi-student-water-points";
const BUS_ROUTE_SOURCE_ID = "chiayi-student-bus-routes";
const BUS_ROUTE_LAYER_ID = "chiayi-student-bus-routes-line";
const BUS_SOURCE_ID = "chiayi-student-bus";
const BUS_LAYER_ID = "chiayi-student-bus-points";
const TRAFFIC_EVENT_SOURCE_ID = "chiayi-student-traffic-events";
const TRAFFIC_EVENT_LINE_LAYER_ID = "chiayi-student-traffic-event-lines";
const TRAFFIC_EVENT_POINT_LAYER_ID = "chiayi-student-traffic-event-points";
const TRAFFIC_SOURCE_ID = "chiayi-student-traffic-congestion";
const TRAFFIC_LAYER_ID = "chiayi-student-traffic-congestion-lines";
const TRAFFIC_SOURCE_LAYER = "road_congestion_highway";
const WATER_STEP_SECONDS = 60 * 60;
const BUS_STEP_SECONDS = 10 * 60;
const TRAFFIC_STEP_SECONDS = 5 * 60;
const TRAFFIC_PM_TILES_URL = import.meta.env.DEV
  ? "/__pulse/road_congestion_highway.pmtiles"
  : "https://mini-taiwan-pulse.itsmigu.com/road/road_congestion_highway.pmtiles";

type BoundaryState = "loading" | "ready" | "error";
type WeatherState = "loading" | "ready" | "stale" | "error";
type TopicLoadState = "idle" | "loading" | "ready" | "error";

const EMPTY_WEATHER: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const TOPIC_META: Record<ChiayiTopicId, {
  title: string;
  subtitle: string;
  note: string;
  legendTitle: string;
  legendNote: string;
}> = {
  weatherForecastPoints: {
    title: "嘉義市雲與天氣模型預報",
    subtitle: "比較不同位置、不同預報有效時間的雲量、降雨與溫度",
    note: "模型預報，不是測站觀測。",
    legendTitle: "☁️ 模型預報點",
    legendNote: "圓點旁的觀察卡會顯示文字與數值；顏色不是唯一資訊。",
  },
  waterRain: {
    title: "嘉義市水與雨",
    subtitle: "用近七日的雨量、河川水位與水資源 IoT 觀測比較時間變化",
    note: "近七日每小時回放；不同測站仍保留自己的觀測時間。",
    legendTitle: "💧 水與雨觀測",
    legendNote: "圓點代表資料來源位置；數值與觀測時間請看左側卡片。",
  },
  publicTransport: {
    title: "嘉義市公共運輸",
    subtitle: "比較嘉義市公車路線與近七日可取得的車輛移動",
    note: "歷史軌跡依 API 可用日期回放，缺少的日期不補資料。",
    legendTitle: "🚌 公車路線與車輛",
    legendNote: "藍線是路線，3D 發光車輛會沿路線進度移動。",
  },
  trafficFlow: {
    title: "嘉義市交通流動與壅塞",
    subtitle: "用近七日五分鐘一格的省道路況與道路事件觀察變化",
    note: "可回看當下往前七日；缺少的日期不補道路狀態。",
    legendTitle: "🚗 交通流動與壅塞",
    legendNote: "綠色較順暢、黃色車多、橘色略壅、紅色壅塞；灰色無資料。",
  },
};

const CHIAYI_STUDENT_CSS = `
  .chiayi-student-shell {
    --ink: #e9f2ff;
    --muted: #9cb1c9;
    --panel: rgba(9, 20, 35, .94);
    --panel-strong: rgba(13, 31, 52, .98);
    --line: rgba(153, 195, 232, .22);
    --accent: #5dd8e8;
    --accent-strong: #9cebf2;
    --warning: #ffd27a;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(250px, 25vw) minmax(0, 1fr);
    grid-template-rows: 72px minmax(0, 1fr) 104px;
    overflow: hidden;
    background: #06111f;
    color: var(--ink);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Noto Sans TC", sans-serif;
    letter-spacing: .01em;
  }
  .chiayi-student-shell *, .chiayi-student-shell *::before, .chiayi-student-shell *::after { box-sizing: border-box; }
  .chiayi-student-header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
    padding: 12px 24px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(90deg, rgba(7, 26, 46, .98), rgba(8, 20, 34, .95));
  }
  .chiayi-student-kicker { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .chiayi-student-title { margin: 3px 0 0; color: #f5fbff; font-size: clamp(18px, 2.2vw, 25px); line-height: 1.15; }
  .chiayi-student-subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
  .chiayi-student-status {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 9px;
    max-width: 45%;
    color: var(--muted);
    font-size: 12px;
    text-align: right;
  }
  .chiayi-student-status-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); box-shadow: 0 0 14px rgba(93, 216, 232, .7); }
  .chiayi-student-status-dot.warning { background: var(--warning); box-shadow: 0 0 14px rgba(255, 210, 122, .45); }
  .chiayi-student-status-dot.error { background: #ff8e8e; box-shadow: 0 0 14px rgba(255, 142, 142, .45); }
  .chiayi-student-education {
    grid-column: 1;
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 16px;
    border-right: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(7, 24, 42, .95), rgba(6, 17, 31, .98));
  }
  .chiayi-student-education-inner { height: 100%; overflow: auto; padding-right: 3px; scrollbar-width: thin; scrollbar-color: rgba(156, 235, 242, .28) transparent; }
  .chiayi-student-education-inner::-webkit-scrollbar { width: 5px; }
  .chiayi-student-education-inner::-webkit-scrollbar-thumb { background: rgba(156, 235, 242, .28); border-radius: 99px; }
  .chiayi-student-card { margin-bottom: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: 0 12px 30px rgba(0, 0, 0, .18); }
  .chiayi-student-card:last-child { margin-bottom: 0; }
  .chiayi-student-card h2, .chiayi-student-card h3 { margin: 0; color: #f5fbff; font-size: 15px; }
  .chiayi-student-label { display: block; margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; }
  .chiayi-student-region-name { margin: 0; font-size: 25px; line-height: 1; }
  .chiayi-student-region-note { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
  .chiayi-student-boundary-status { display: inline-flex; align-items: center; gap: 6px; margin-top: 11px; color: var(--accent-strong); font-size: 11px; }
  .chiayi-student-boundary-status.error { color: var(--warning); }
  .chiayi-student-topic-select { width: 100%; min-height: 44px; padding: 9px 10px; border: 1px solid rgba(156, 235, 242, .35); border-radius: 9px; background: #0b2138; color: var(--ink); font: inherit; font-size: 13px; }
  .chiayi-student-topic-select:focus, .chiayi-student-shell button:focus-visible, .chiayi-student-shell input:focus-visible { outline: 3px solid rgba(156, 235, 242, .8); outline-offset: 2px; }
  .chiayi-student-topic-note { margin: 9px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
  .chiayi-student-point-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 11px; }
  .chiayi-student-point-button { min-height: 44px; padding: 8px 9px; border: 1px solid rgba(156, 235, 242, .22); border-radius: 9px; background: rgba(20, 54, 82, .7); color: var(--ink); cursor: pointer; font: inherit; font-size: 12px; text-align: left; }
  .chiayi-student-point-button:hover, .chiayi-student-point-button[aria-pressed="true"] { border-color: var(--accent); background: rgba(40, 102, 124, .78); }
  .chiayi-student-point-button small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
  .chiayi-student-observation-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .chiayi-student-toggle { min-height: 40px; padding: 7px 9px; border: 1px solid rgba(156, 235, 242, .3); border-radius: 8px; background: transparent; color: var(--accent-strong); cursor: pointer; font: inherit; font-size: 11px; }
  .chiayi-student-observation-content { margin-top: 12px; }
  .chiayi-student-observation-intro { margin: 0 0 12px; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .chiayi-student-value-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .chiayi-student-value { padding: 9px; border-radius: 9px; background: rgba(11, 33, 56, .85); }
  .chiayi-student-value-label { display: block; color: var(--muted); font-size: 10px; }
  .chiayi-student-value-number { display: block; margin-top: 4px; color: #f5fbff; font-size: 16px; font-variant-numeric: tabular-nums; }
  .chiayi-student-meta { margin: 12px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
  .chiayi-student-meta strong { color: var(--accent-strong); font-weight: 600; }
  .chiayi-student-error { margin: 10px 0 0; padding: 10px; border-left: 3px solid #ff8e8e; border-radius: 6px; background: rgba(105, 38, 48, .28); color: #ffd5d5; font-size: 12px; line-height: 1.55; }
  .chiayi-student-map-stage { grid-column: 2; grid-row: 2; position: relative; min-width: 0; min-height: 0; overflow: hidden; background: #0e2336; }
  .chiayi-student-map { position: absolute; inset: 0; }
  .chiayi-student-map-legend { position: absolute; left: 14px; top: 14px; z-index: 2; max-width: min(300px, calc(100% - 80px)); padding: 10px 12px; border: 1px solid rgba(156, 235, 242, .28); border-radius: 10px; background: rgba(7, 24, 42, .87); color: #e9f2ff; pointer-events: none; }
  .chiayi-student-map-legend strong { display: block; font-size: 12px; }
  .chiayi-student-map-legend span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.45; }
  .chiayi-student-map-message { position: absolute; left: 50%; top: 50%; z-index: 1; transform: translate(-50%, -50%); max-width: min(360px, 75%); padding: 12px 14px; border: 1px solid rgba(255, 210, 122, .42); border-radius: 10px; background: rgba(25, 24, 15, .9); color: #ffe6a9; font-size: 12px; line-height: 1.55; text-align: center; pointer-events: none; }
  .chiayi-student-time-controller { grid-column: 1 / -1; grid-row: 3; min-width: 0; min-height: 0; padding: 12px 24px 15px; border-top: 1px solid var(--line); background: var(--panel-strong); }
  .chiayi-student-time-inner { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 12px; max-width: 1280px; height: 100%; margin: 0 auto; }
  .chiayi-student-time-label { grid-column: 1; grid-row: 1; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
  .chiayi-student-time-value { grid-column: 3; grid-row: 1; min-width: 145px; color: var(--accent-strong); font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .chiayi-student-time-range { grid-column: 2; grid-row: 1; width: 100%; min-width: 44px; height: 44px; margin: 0; accent-color: var(--accent); cursor: pointer; }
  .chiayi-student-time-ends { grid-column: 2; grid-row: 2; display: flex; justify-content: space-between; gap: 14px; margin-top: 2px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .chiayi-student-time-actions { grid-column: 4; grid-row: 1; display: flex; align-items: center; gap: 6px; }
  .chiayi-student-time-action { min-height: 40px; padding: 7px 10px; border: 1px solid rgba(156, 235, 242, .35); border-radius: 8px; background: rgba(20, 54, 82, .72); color: var(--accent-strong); cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
  .chiayi-student-time-action:disabled { cursor: not-allowed; opacity: .45; }
  .chiayi-student-attribution { position: absolute; right: 0; bottom: 0; z-index: 3; max-width: min(96%, 540px); padding: 4px 8px; border-top-left-radius: 7px; background: rgba(7, 16, 27, .84); color: #c7d5e5; font-size: 10px; line-height: 1.4; text-align: right; }
  .chiayi-student-attribution a { color: var(--accent-strong); }
  .chiayi-student-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 680px) {
    .chiayi-student-shell { grid-template-columns: 1fr; grid-template-rows: 72px minmax(0, 1fr) minmax(142px, 19vh) 128px; }
    .chiayi-student-header { padding: 10px 15px; }
    .chiayi-student-subtitle { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chiayi-student-status { max-width: 42%; font-size: 11px; }
    .chiayi-student-education { grid-column: 1; grid-row: 3; padding: 9px 12px; border-right: 0; border-top: 1px solid var(--line); }
    .chiayi-student-education-inner { overflow: auto; }
    .chiayi-student-education-inner > .chiayi-student-card { margin-bottom: 7px; }
    .chiayi-student-region-topic-row { display: grid; grid-template-columns: .34fr .66fr; gap: 8px; }
    .chiayi-student-region-topic-row .chiayi-student-card { min-width: 0; }
    .chiayi-student-card { padding: 10px; border-radius: 11px; }
    .chiayi-student-region-name { font-size: 20px; }
    .chiayi-student-region-note, .chiayi-student-topic-note { margin-top: 5px; overflow: hidden; font-size: 10px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    .chiayi-student-boundary-status { margin-top: 6px; font-size: 10px; }
    .chiayi-student-topic-select { min-height: 44px; padding: 7px 8px; font-size: 12px; }
    .chiayi-student-point-list { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; margin-top: 6px; }
    .chiayi-student-point-button { min-height: 44px; padding: 6px; font-size: 10px; }
    .chiayi-student-point-button small { font-size: 9px; }
    .chiayi-student-observation-card { max-height: 100%; overflow: auto; }
    .chiayi-student-observation-content { margin-top: 7px; }
    .chiayi-student-observation-intro { margin-bottom: 7px; font-size: 11px; line-height: 1.4; }
    .chiayi-student-value-grid { gap: 5px; }
    .chiayi-student-value { padding: 6px; }
    .chiayi-student-value-number { margin-top: 2px; font-size: 14px; }
    .chiayi-student-meta { margin-top: 7px; font-size: 10px; line-height: 1.4; }
    .chiayi-student-toggle { min-height: 40px; padding: 5px 7px; }
    .chiayi-student-map-stage { grid-column: 1; grid-row: 2; }
    .chiayi-student-map-legend { left: 9px; top: 9px; max-width: calc(100% - 70px); padding: 7px 9px; }
    .chiayi-student-map-legend strong { font-size: 11px; }
    .chiayi-student-map-legend span { font-size: 10px; }
    .chiayi-student-time-controller { grid-column: 1; grid-row: 4; padding: 8px 12px 11px; }
    .chiayi-student-time-inner { grid-template-columns: 1fr auto; gap: 2px 10px; }
    .chiayi-student-time-label { grid-column: 1; }
    .chiayi-student-time-value { grid-column: 2; min-width: 0; font-size: 12px; text-align: right; }
    .chiayi-student-time-actions { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
    .chiayi-student-time-range { grid-column: 1 / -1; grid-row: 3; }
    .chiayi-student-time-ends { grid-column: 1 / -1; grid-row: 4; }
    .chiayi-student-time-action { min-height: 36px; padding: 6px 9px; }
  }
`;

function formatTaiwanTime(value: string): string {
  if (!value) return "無資料";
  const iso = value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}+08:00`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return value.replace("T", " ");
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function formatFetchedAt(value: string): string {
  return formatTaiwanTime(value).replace("24:", "00:");
}

function formatNumber(value: number | null, unit: string, digits = 1): string {
  return value === null ? "無資料" : `${value.toFixed(digits)} ${unit}`;
}

function boundaryBbox(boundary: GeoJSON.FeatureCollection): [[number, number], [number, number]] | null {
  const positions = getBoundaryPositions(boundary);
  if (positions.length === 0) return null;
  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return [
    [Math.min(...longitudes), Math.min(...latitudes)],
    [Math.max(...longitudes), Math.max(...latitudes)],
  ];
}

function forecastValue(point: WeatherForecastData["points"][number], index: number): WeatherHourlyValue {
  return point.hourly[index] ?? point.current;
}

function weatherToFeatureCollection(
  weather: WeatherForecastData | null,
  timeIndex: number,
): GeoJSON.FeatureCollection {
  if (!weather) return EMPTY_WEATHER;
  return {
    type: "FeatureCollection",
    features: weather.points.map((point) => {
      const value = forecastValue(point, timeIndex);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [point.sourceGridLongitude, point.sourceGridLatitude] },
        properties: {
          pointId: point.pointId,
          label: point.label,
          validAt: value.validAt,
          temperature2mC: value.temperature2mC,
          precipitationMm: value.precipitationMm,
          rainMm: value.rainMm,
          cloudCoverPct: value.cloudCoverPct,
        },
      };
    }),
  };
}

function shortWeatherError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "服務回應無法確認，請稍後再試。";
}

interface ChiayiMapCanvasProps {
  boundary: GeoJSON.FeatureCollection | null;
  weather: WeatherForecastData | null;
  timeIndex: number;
  onSelectPoint: (pointId: string) => void;
}

function ChiayiMapCanvas({ boundary, weather, timeIndex, onSelectPoint }: ChiayiMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const selectPointRef = useRef(onSelectPoint);
  const [mapReady, setMapReady] = useState(false);
  selectPointRef.current = onSelectPoint;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
        },
        layers: [{ id: "osm-raster", type: "raster", source: "osm", paint: { "raster-opacity": 0.86 } }],
      },
      center: CHIAYI_CENTER,
      zoom: 11,
      minZoom: 8,
      maxZoom: 16,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const onLoad = () => {
      if (!disposed) setMapReady(true);
    };
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: [WEATHER_LAYER_ID] });
      const pointId = hits[0]?.properties?.pointId;
      if (typeof pointId === "string") selectPointRef.current(pointId);
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: [WEATHER_LAYER_ID] });
      map.getCanvas().style.cursor = hits.length > 0 ? "pointer" : "";
    };
    map.once("load", onLoad);
    map.on("click", onClick);
    map.on("mousemove", onMove);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => map.resize());
    resizeObserver?.observe(container);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      map.off("click", onClick);
      map.off("mousemove", onMove);
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!map.getSource(BOUNDARY_SOURCE_ID)) {
      map.addSource(BOUNDARY_SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "chiayi-student-boundary-fill",
        type: "fill",
        source: BOUNDARY_SOURCE_ID,
        paint: { "fill-color": "#49bfd0", "fill-opacity": 0.09 },
      });
      map.addLayer({
        id: "chiayi-student-boundary-line",
        type: "line",
        source: BOUNDARY_SOURCE_ID,
        paint: { "line-color": "#8ceaf1", "line-width": 2, "line-opacity": 0.95 },
      });
      map.addSource(WEATHER_SOURCE_ID, { type: "geojson", data: EMPTY_WEATHER });
      map.addLayer({
        id: WEATHER_LAYER_ID,
        type: "circle",
        source: WEATHER_SOURCE_ID,
        paint: {
          "circle-color": "#075e91",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 12, 10, 16, 14],
          "circle-opacity": 0.95,
          "circle-stroke-color": "#d9fbff",
          "circle-stroke-width": 2,
        },
      });
    }
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !boundary) return;
    const source = map.getSource(BOUNDARY_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    source?.setData(boundary);
    const boundaryGeometry = boundary.features[0]?.geometry;
    if (boundaryGeometry && map.getLayer(TRAFFIC_LAYER_ID)) {
      map.setFilter(TRAFFIC_LAYER_ID, ["within", boundaryGeometry] as any);
    }
    const bounds = boundaryBbox(boundary);
    if (bounds) map.fitBounds(bounds, { padding: 44, duration: 0, maxZoom: 12.5 });
  }, [boundary, mapReady]);

  const weatherFeatures = useMemo(() => weatherToFeatureCollection(weather, timeIndex), [weather, timeIndex]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(WEATHER_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    source?.setData(weatherFeatures);
  }, [mapReady, weatherFeatures]);

  return <div ref={containerRef} className="chiayi-student-map" aria-label="嘉義市互動地圖" />;
}

function LegacyWeatherStudentApp() {
  const [boundary, setBoundary] = useState<GeoJSON.FeatureCollection | null>(null);
  const [boundaryState, setBoundaryState] = useState<BoundaryState>("loading");
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherForecastData | null>(null);
  const [weatherError, setWeatherError] = useState<unknown>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [timeIndex, setTimeIndex] = useState(0);
  const [observationOpen, setObservationOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= 680);
  const observationHeadingRef = useRef<HTMLHeadingElement>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBoundaryState("loading");
    setWeatherError(null);
    void (async () => {
      try {
        const nextBoundary = await fetchChiayiBoundary(controller.signal);
        if (!active) return;
        setBoundary(nextBoundary);
        setBoundaryState("ready");
        const points = buildWeatherQueryPoints(nextBoundary);
        try {
          const nextWeather = await fetchChiayiWeatherForecast({ points, boundary: nextBoundary, signal: controller.signal });
          if (!active) return;
          setWeather(nextWeather);
          setSelectedPointId(nextWeather.points[0]?.pointId ?? null);
          setTimeIndex(0);
        } catch (error) {
          if (!active || (error instanceof Error && error.name === "WeatherLoaderError" && "aborted" === (error as { code?: string }).code)) return;
          setWeatherError(error);
        }
      } catch (error) {
        if (!active || (error instanceof Error && error.name === "BoundaryLoaderError" && "aborted" === (error as { code?: string }).code)) return;
        setBoundaryState("error");
        setBoundaryError(shortWeatherError(error));
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 680);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!weather) return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [weather]);

  const weatherState: WeatherState = resolveWeatherDisplayState(weather, weatherError !== null, clockMs);
  const selectedPoint = weather?.points.find((point) => point.pointId === selectedPointId) ?? weather?.points[0];
  const selectedValue = selectedPoint ? forecastValue(selectedPoint, timeIndex) : null;
  const timeCount = selectedPoint?.hourly.length ?? 0;
  const displayedTimeIndex = timeCount > 0 ? Math.min(timeIndex, timeCount - 1) : 0;
  const firstForecast = selectedPoint?.hourly[0];
  const lastForecast = selectedPoint && timeCount > 0 ? selectedPoint.hourly[timeCount - 1] : undefined;

  const selectPoint = (pointId: string, moveFocus = false) => {
    setSelectedPointId(pointId);
    if (moveFocus) {
      window.requestAnimationFrame(() => observationHeadingRef.current?.focus());
    }
  };

  const statusTone = boundaryState === "error" || weatherState === "error" ? "error" : weatherState === "stale" ? "warning" : "";
  const statusText = boundaryState === "loading"
    ? "正在取得嘉義市界線"
    : boundaryState === "error"
      ? "嘉義市界線無法載入"
      : weatherState === "loading"
        ? "正在取得嘉義天氣模型資料"
        : weatherState === "stale"
          ? "天氣模型資料可能已過期"
          : weatherState === "error"
            ? "目前沒有天氣模型資料"
            : "嘉義市天氣模型預報";
  const observationOpenForView = !isNarrow || observationOpen;

  return (
    <div className="chiayi-student-shell" data-testid="chiayi-student-shell">
      <style>{CHIAYI_STUDENT_CSS}</style>
      <header className="chiayi-student-header">
        <div>
          <div className="chiayi-student-kicker">Mini Taiwan Pulse · Student MVP</div>
          <h1 className="chiayi-student-title">嘉義市天氣模型預報</h1>
          <p className="chiayi-student-subtitle">比較不同位置、不同預報有效時間的雲量、降雨與溫度</p>
        </div>
        <div className="chiayi-student-status" data-testid="chiayi-weather-status" role="status" aria-live="polite">
          <span className={`chiayi-student-status-dot ${statusTone}`} aria-hidden="true" />
          <span>{statusText}</span>
        </div>
      </header>

      <aside className="chiayi-student-education" aria-label="嘉義市學習面板">
        <div className="chiayi-student-education-inner">
          <div className="chiayi-student-region-topic-row">
            <section className="chiayi-student-card" data-testid="chiayi-region-status" aria-labelledby="chiayi-region-heading">
              <span className="chiayi-student-label">區域</span>
              <h2 id="chiayi-region-heading" className="chiayi-student-region-name">嘉義市</h2>
              <p className="chiayi-student-region-note">嘉義縣不在本次範圍。</p>
              <span className={`chiayi-student-boundary-status ${boundaryState === "error" ? "error" : ""}`} data-testid="chiayi-boundary-status">
                <span aria-hidden="true">{boundaryState === "ready" ? "●" : "○"}</span>
                {boundaryState === "ready" ? "正式市界已載入" : boundaryState === "loading" ? "正式市界載入中" : "正式市界無法載入"}
              </span>
            </section>

            <section className="chiayi-student-card" data-testid="chiayi-topic-selector" aria-labelledby="chiayi-topic-heading">
              <label id="chiayi-topic-heading" className="chiayi-student-label" htmlFor="chiayi-topic">唯一主題</label>
              <select id="chiayi-topic" className="chiayi-student-topic-select" value="weatherForecastPoints" onChange={() => undefined}>
                <option value="weatherForecastPoints">☁️ 雲與天氣模型預報</option>
              </select>
              <p className="chiayi-student-topic-note">模型預報，不是測站觀測。</p>
            </section>
          </div>

          <section className="chiayi-student-card" data-testid="chiayi-observation-card" aria-labelledby="chiayi-observation-heading">
            <div className="chiayi-student-observation-header">
              <h2 id="chiayi-observation-heading" ref={observationHeadingRef} tabIndex={-1}>觀察說明</h2>
              {isNarrow && (
                <button type="button" className="chiayi-student-toggle" aria-expanded={observationOpen} onClick={() => setObservationOpen((open) => !open)}>
                  {observationOpen ? "收合" : "展開"}
                </button>
              )}
            </div>
            {observationOpenForView && (
              <div className="chiayi-student-observation-content">
                <p className="chiayi-student-observation-intro">
                  先選一個模型格網中心，再移動下方的「預報有效時間」。最後選另一個位置比較。來源會把座標吸附到可用的模型格網，所以模型點不是測站。
                </p>
                {weather?.points.length ? (
                  <div className="chiayi-student-point-list" data-testid="chiayi-point-list" aria-label="模型格網位置">
                    {weather.points.map((point) => (
                      <button
                        key={point.pointId}
                        type="button"
                        className="chiayi-student-point-button"
                        aria-pressed={point.pointId === selectedPoint?.pointId}
                        onClick={() => selectPoint(point.pointId, true)}
                      >
                        {point.label}
                        <small>{point.sourceGridLatitude.toFixed(3)}°N · {point.sourceGridLongitude.toFixed(3)}°E</small>
                      </button>
                    ))}
                  </div>
                ) : null}
                {weatherState === "loading" && <p className="chiayi-student-meta">正在準備模型預報點，地圖仍可拖曳與縮放。</p>}
                {weatherState === "error" && <p className="chiayi-student-error">目前沒有天氣模型資料。{shortWeatherError(weatherError)}</p>}
                {boundaryError && <p className="chiayi-student-error">正式市界載入失敗，為避免誤導，本次不顯示天氣模型點。{boundaryError}</p>}
                {selectedPoint && selectedValue && weatherState !== "error" && (
                  <>
                    <div className="chiayi-student-value-grid" aria-label="選取位置的天氣預報數值">
                      <div className="chiayi-student-value"><span className="chiayi-student-value-label">溫度</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.temperature2mC, "°C")}</strong></div>
                      <div className="chiayi-student-value"><span className="chiayi-student-value-label">降水量／逐時</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.precipitationMm, "mm")}</strong></div>
                      <div className="chiayi-student-value"><span className="chiayi-student-value-label">雨量強度</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.rainMm, "mm")}</strong></div>
                      <div className="chiayi-student-value"><span className="chiayi-student-value-label">雲量</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.cloudCoverPct, "%", 0)}</strong></div>
                    </div>
                    <p className="chiayi-student-meta">
                      <strong>{selectedPoint.label}</strong> · 模型格網中心<br />
                      預報有效時間：<strong>{formatTaiwanTime(selectedValue.validAt)}</strong><br />
                      資料取得時間：{formatFetchedAt(weather?.fetchedAt ?? "")}<br />
                      資料角色：模型預報（不是測站觀測）
                    </p>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </aside>

      <main className="chiayi-student-map-stage" data-testid="chiayi-map-stage" aria-label="嘉義市天氣模型地圖">
        <ChiayiMapCanvas boundary={boundary} weather={weatherState === "error" ? null : weather} timeIndex={displayedTimeIndex} onSelectPoint={(pointId) => selectPoint(pointId)} />
        <div className="chiayi-student-map-legend" aria-hidden="true">
          <strong>☁️ 模型預報點</strong>
          <span>圓點旁的觀察卡會顯示文字與數值；顏色不是唯一資訊。</span>
        </div>
        {boundaryState === "error" && <div className="chiayi-student-map-message">正式嘉義市界線無法載入，為避免把候選範圍當成市界，這次不畫界線與天氣點。</div>}
        <div className="chiayi-student-attribution">
          底圖 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a>
        </div>
      </main>

      <section className="chiayi-student-time-controller" data-testid="chiayi-time-controller" aria-label="預報有效時間">
        <div className="chiayi-student-time-inner">
          <label className="chiayi-student-time-label" htmlFor="chiayi-forecast-time">預報有效時間</label>
          <output className="chiayi-student-time-value" htmlFor="chiayi-forecast-time">{selectedValue ? formatTaiwanTime(selectedValue.validAt) : "等待資料"}</output>
          <input
            id="chiayi-forecast-time"
            className="chiayi-student-time-range"
            type="range"
            min={0}
            max={Math.max(0, timeCount - 1)}
            value={displayedTimeIndex}
            disabled={!selectedPoint || weatherState === "error"}
            onChange={(event) => setTimeIndex(Number(event.target.value))}
            aria-label="選擇預報有效時間"
          />
          <div className="chiayi-student-time-ends"><span>{firstForecast ? formatTaiwanTime(firstForecast.validAt) : "目前"}</span><span>{lastForecast ? formatTaiwanTime(lastForecast.validAt) : "未來 48 小時"}</span></div>
        </div>
      </section>

      <p className="chiayi-student-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="chiayi-live-region">
        {selectedPoint && selectedValue ? `${selectedPoint.label}，${formatTaiwanTime(selectedValue.validAt)}，溫度 ${formatNumber(selectedValue.temperature2mC, "°C")}，雲量 ${formatNumber(selectedValue.cloudCoverPct, "%", 0)}，資料角色為模型預報。` : statusText}
      </p>
    </div>
  );
}

function shortTopicError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "服務回應無法確認，請稍後再試。";
}

void LegacyWeatherStudentApp;

interface WaterStationsLike {
  rainGauge: ChiayiWaterFrame["rainGauge"];
  riverLevel: ChiayiWaterFrame["riverLevel"];
  iotRiver: ChiayiWaterFrame["iotRiver"];
}

interface ChiayiTransportFrame {
  routes: ChiayiBusRouteFeature[];
  buses: ChiayiBusPoint[];
}

function waterToFeatureCollection(water: WaterStationsLike | null): GeoJSON.FeatureCollection {
  if (!water) return EMPTY_GEOJSON;
  const stations = [...water.rainGauge, ...water.riverLevel, ...water.iotRiver];
  return {
    type: "FeatureCollection",
    features: stations.map((station) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [station.longitude, station.latitude] },
      properties: {
        id: station.id,
        name: station.name,
        kind: station.kind,
        value: station.value,
        secondaryValue: station.secondaryValue,
        unit: station.unit,
        observedAt: station.observedAt,
        status: station.status ?? "",
      },
    })),
  };
}

function transportRoutesToFeatureCollection(
  routes: readonly ChiayiBusRouteFeature[] | null,
): GeoJSON.FeatureCollection {
  if (!routes) return EMPTY_GEOJSON;
  return {
    type: "FeatureCollection",
    features: routes.map((route) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: route.coordinates },
      properties: {
        routeUid: route.routeUid,
        routeName: route.routeName,
        direction: route.direction,
      },
    })),
  };
}

function transportBusesToFeatureCollection(
  buses: readonly ChiayiBusPoint[] | null,
): GeoJSON.FeatureCollection {
  if (!buses) return EMPTY_GEOJSON;
  return {
    type: "FeatureCollection",
    features: buses.map((bus) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [bus.longitude, bus.latitude] },
      properties: {
        id: bus.id,
        plateNumber: bus.plateNumber,
        routeUid: bus.routeUid ?? "",
        routeName: bus.routeName ?? "未知路線",
        direction: bus.direction,
        speedKmh: bus.speedKmh,
        observedAt: bus.observedAt,
      },
    })),
  };
}

function trafficEventsToFeatureCollection(
  traffic: ChiayiTrafficData | null,
  slot: number,
): GeoJSON.FeatureCollection {
  if (!traffic) return EMPTY_GEOJSON;
  const timestamp = trafficSlotTimestamp(traffic.date, slot);
  return {
    type: "FeatureCollection",
    features: traffic.events.map((event) => {
      const active =
        (event.startTs === 0 || timestamp >= event.startTs) &&
        (event.endTs == null || timestamp < event.endTs);
      return {
        type: "Feature",
        geometry: event.geometry,
        properties: {
          id: event.id,
          source: event.source,
          title: event.title,
          roadName: event.roadName ?? "",
          eventType: event.eventType ?? 0,
          severity: event.severity ?? 0,
          active: active ? 1 : 0,
        },
      };
    }),
  };
}

function allWaterStations(water: WaterStationsLike | null) {
  return water ? [...water.rainGauge, ...water.riverLevel, ...water.iotRiver] : [];
}

function latestStationObservedAt(stations: readonly { observedAt: string }[]): string | null {
  return stations
    .map((station) => station.observedAt)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

interface MultiTopicMapCanvasProps {
  boundary: GeoJSON.FeatureCollection | null;
  activeTopic: ChiayiTopicId;
  weather: WeatherForecastData | null;
  water: ChiayiWaterFrame | null;
  transport: ChiayiTransportFrame | null;
  transportWeek: ChiayiPublicTransportWeekData | null;
  transportTimestamp: number;
  traffic: ChiayiTrafficData | null;
  weatherTimeIndex: number;
  trafficSlot: number;
  onSelectPoint: (pointId: string) => void;
}

function MultiTopicMapCanvas({
  boundary,
  activeTopic,
  weather,
  water,
  transport,
  transportWeek,
  transportTimestamp,
  traffic,
  weatherTimeIndex,
  trafficSlot,
  onSelectPoint,
}: MultiTopicMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const bus3dControllerRef = useRef<ChiayiBus3dController | null>(null);
  const selectPointRef = useRef(onSelectPoint);
  const trafficStateIdsRef = useRef<string[]>([]);
  const [mapReady, setMapReady] = useState(false);
  selectPointRef.current = onSelectPoint;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    registerPmtilesProtocolOnce();
    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
        },
        layers: [{ id: "osm-raster", type: "raster", source: "osm", paint: { "raster-opacity": 0.86 } }],
      },
      center: CHIAYI_CENTER,
      zoom: 11,
      minZoom: 8,
      maxZoom: 16,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const onLoad = () => {
      if (!disposed) setMapReady(true);
    };
    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(WEATHER_LAYER_ID)) return;
      const hits = map.queryRenderedFeatures(event.point, { layers: [WEATHER_LAYER_ID] });
      const pointId = hits[0]?.properties?.pointId;
      if (typeof pointId === "string") selectPointRef.current(pointId);
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(WEATHER_LAYER_ID)) return;
      const hits = map.queryRenderedFeatures(event.point, { layers: [WEATHER_LAYER_ID] });
      map.getCanvas().style.cursor = hits.length > 0 ? "pointer" : "";
    };
    map.once("load", onLoad);
    map.on("click", onClick);
    map.on("mousemove", onMove);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => map.resize());
    resizeObserver?.observe(container);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      map.off("click", onClick);
      map.off("mousemove", onMove);
      mapRef.current = null;
      bus3dControllerRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (map.getSource(BOUNDARY_SOURCE_ID)) return;

    map.addSource(BOUNDARY_SOURCE_ID, { type: "geojson", data: EMPTY_GEOJSON });
    map.addLayer({
      id: "chiayi-student-boundary-fill",
      type: "fill",
      source: BOUNDARY_SOURCE_ID,
      paint: { "fill-color": "#49bfd0", "fill-opacity": 0.09 },
    });
    map.addLayer({
      id: "chiayi-student-boundary-line",
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      paint: { "line-color": "#8ceaf1", "line-width": 2, "line-opacity": 0.95 },
    });
    map.addSource(WEATHER_SOURCE_ID, { type: "geojson", data: EMPTY_WEATHER });
    map.addLayer({
      id: WEATHER_LAYER_ID,
      type: "circle",
      source: WEATHER_SOURCE_ID,
      paint: {
        "circle-color": "#075e91",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 12, 10, 16, 14],
        "circle-opacity": 0.95,
        "circle-stroke-color": "#d9fbff",
        "circle-stroke-width": 2,
      },
    });
    map.addSource(WATER_SOURCE_ID, { type: "geojson", data: EMPTY_GEOJSON });
    map.addLayer({
      id: WATER_LAYER_ID,
      type: "circle",
      source: WATER_SOURCE_ID,
      paint: {
        "circle-color": [
          "match",
          ["get", "kind"],
          "rainGauge", "#38bdf8",
          "riverLevel", "#60a5fa",
          "#a78bfa",
        ],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 12, 9, 16, 12],
        "circle-opacity": 0.95,
        "circle-stroke-color": "#ecfeff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addSource(BUS_ROUTE_SOURCE_ID, { type: "geojson", data: EMPTY_GEOJSON });
    map.addLayer({
      id: BUS_ROUTE_LAYER_ID,
      type: "line",
      source: BUS_ROUTE_SOURCE_ID,
      paint: { "line-color": "#fbbf24", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.5, 16, 4], "line-opacity": 0.75 },
    });
    map.addSource(BUS_SOURCE_ID, { type: "geojson", data: EMPTY_GEOJSON });
    map.addLayer({
      id: BUS_LAYER_ID,
      type: "circle",
      source: BUS_SOURCE_ID,
      paint: { "circle-color": "#f97316", "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 8, 16, 11], "circle-stroke-color": "#fff7ed", "circle-stroke-width": 2 },
    });
    map.addSource(TRAFFIC_EVENT_SOURCE_ID, { type: "geojson", data: EMPTY_GEOJSON });
    map.addLayer({
      id: TRAFFIC_EVENT_LINE_LAYER_ID,
      type: "line",
      source: TRAFFIC_EVENT_SOURCE_ID,
      paint: {
        "line-color": ["match", ["get", "eventType"], 3, "#ef4444", 2, "#f97316", 5, "#dc2626", 7, "#a855f7", "#eab308"],
        "line-width": 4,
        "line-opacity": ["case", ["==", ["get", "active"], 1], 0.9, 0.18],
      },
    });
    map.addLayer({
      id: TRAFFIC_EVENT_POINT_LAYER_ID,
      type: "circle",
      source: TRAFFIC_EVENT_SOURCE_ID,
      paint: {
        "circle-color": ["match", ["get", "eventType"], 3, "#ef4444", 2, "#f97316", 5, "#dc2626", 7, "#a855f7", "#eab308"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 8, 16, 11],
        "circle-opacity": ["case", ["==", ["get", "active"], 1], 0.95, 0.2],
        "circle-stroke-color": "#fff7ed",
        "circle-stroke-width": 1.5,
      },
    });

    // 嘉義學生版沿用主站的 BusEngine + BusScene，但透過 MapLibre wrapper
    // 取得 defaultProjectionData.mainMatrix，避免另開 canvas 或偏離地圖。
    const bus3dController = createChiayiBus3dController();
    bus3dControllerRef.current = bus3dController;
    map.addLayer(bus3dController.layer);
  }, [mapReady]);

  useEffect(() => {
    const controller = bus3dControllerRef.current;
    const map = mapRef.current;
    if (!controller || !map || !mapReady) return;
    controller.setBoundary(boundary);
    controller.setData(transportWeek);
    map.triggerRepaint();
  }, [boundary, mapReady, transportWeek]);

  useEffect(() => {
    const controller = bus3dControllerRef.current;
    const map = mapRef.current;
    if (!controller || !map || !mapReady) return;
    controller.setTime(transportTimestamp);
    controller.setVisible(activeTopic === "publicTransport" && transportWeek !== null);
    map.triggerRepaint();
  }, [activeTopic, mapReady, transportTimestamp, transportWeek]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || activeTopic !== "trafficFlow" || map.getSource(TRAFFIC_SOURCE_ID)) return;
    const trafficPmtilesUrl = typeof window === "undefined"
      ? "https://mini-taiwan-pulse.itsmigu.com/road/road_congestion_highway.pmtiles"
      : new URL(TRAFFIC_PM_TILES_URL, window.location.href).toString();
    map.addSource(TRAFFIC_SOURCE_ID, {
      type: "vector",
      url: `pmtiles://${trafficPmtilesUrl}`,
      minzoom: 5,
      maxzoom: 14,
      promoteId: { [TRAFFIC_SOURCE_LAYER]: "section_uid" },
    } as any);
    map.addLayer({
      id: TRAFFIC_LAYER_ID,
      type: "line",
      source: TRAFFIC_SOURCE_ID,
      "source-layer": TRAFFIC_SOURCE_LAYER,
      paint: {
        "line-color": ["match", ["feature-state", "level"], 1, ROAD_CONGESTION_COLORS[1] ?? "#22c55e", 2, ROAD_CONGESTION_COLORS[2] ?? "#eab308", 3, ROAD_CONGESTION_COLORS[3] ?? "#f97316", 4, ROAD_CONGESTION_COLORS[4] ?? "#ef4444", ROAD_CONGESTION_COLORS[0] ?? "#808080"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 4, 16, 7],
        "line-opacity": 0.9,
      },
    });
    const boundaryGeometry = boundary?.features[0]?.geometry;
    if (boundaryGeometry) map.setFilter(TRAFFIC_LAYER_ID, ["within", boundaryGeometry] as any);
  }, [activeTopic, boundary, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !boundary) return;
    const source = map.getSource(BOUNDARY_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    source?.setData(boundary);
    const bounds = boundaryBbox(boundary);
    if (bounds) {
      map.fitBounds(bounds, { padding: 44, duration: 0, maxZoom: 12.5 });
      map.setMaxBounds([
        [bounds[0][0] - 0.07, bounds[0][1] - 0.06],
        [bounds[1][0] + 0.07, bounds[1][1] + 0.06],
      ]);
    }
  }, [boundary, mapReady]);

  const weatherFeatures = useMemo(() => weatherToFeatureCollection(weather, weatherTimeIndex), [weather, weatherTimeIndex]);
  const waterFeatures = useMemo(() => waterToFeatureCollection(water), [water]);
  const routeFeatures = useMemo(() => transportRoutesToFeatureCollection(transport?.routes ?? null), [transport]);
  const busFeatures = useMemo(() => transportBusesToFeatureCollection(transport?.buses ?? null), [transport]);
  const eventFeatures = useMemo(() => trafficEventsToFeatureCollection(traffic, trafficSlot), [traffic, trafficSlot]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(WEATHER_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    source?.setData(weatherFeatures);
  }, [mapReady, weatherFeatures]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(WATER_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    source?.setData(waterFeatures);
  }, [mapReady, waterFeatures]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const routeSource = map.getSource(BUS_ROUTE_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    const busSource = map.getSource(BUS_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    routeSource?.setData(routeFeatures);
    busSource?.setData(busFeatures);
  }, [busFeatures, mapReady, routeFeatures]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(TRAFFIC_EVENT_SOURCE_ID) as { setData: (data: GeoJSON.GeoJSON) => void } | undefined;
    source?.setData(eventFeatures);
  }, [eventFeatures, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const bus3dVisible = activeTopic === "publicTransport" && transportWeek !== null;
    const layers = [
      [WEATHER_LAYER_ID, activeTopic === "weatherForecastPoints"],
      [WATER_LAYER_ID, activeTopic === "waterRain"],
      [BUS_ROUTE_LAYER_ID, activeTopic === "publicTransport"],
      // 3D layer ready 後不再疊 2D 圓點；保留 2D source 作為 WebGL 降級基線。
      [BUS_LAYER_ID, activeTopic === "publicTransport" && !bus3dVisible],
      [TRAFFIC_LAYER_ID, activeTopic === "trafficFlow"],
      [TRAFFIC_EVENT_LINE_LAYER_ID, activeTopic === "trafficFlow"],
      [TRAFFIC_EVENT_POINT_LAYER_ID, activeTopic === "trafficFlow"],
    ] as const;
    layers.forEach(([layerId, visible]) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    });
  }, [activeTopic, mapReady, transportWeek]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    trafficStateIdsRef.current.forEach((id) => {
      map.removeFeatureState({ source: TRAFFIC_SOURCE_ID, sourceLayer: TRAFFIC_SOURCE_LAYER, id });
    });
    const nextIds: string[] = [];
    if (!traffic?.congestion) {
      trafficStateIdsRef.current = nextIds;
      return;
    }
    traffic.congestion.sections.forEach((section) => {
      const level = levelFromChar(section.timeline[trafficSlot]);
      map.setFeatureState(
        { source: TRAFFIC_SOURCE_ID, sourceLayer: TRAFFIC_SOURCE_LAYER, id: section.section_uid },
        { level },
      );
      nextIds.push(section.section_uid);
    });
    trafficStateIdsRef.current = nextIds;
  }, [mapReady, traffic, trafficSlot]);

  return <div ref={containerRef} className="chiayi-student-map" aria-label="嘉義市互動地圖" />;
}

export function ChiayiStudentApp() {
  const [boundary, setBoundary] = useState<GeoJSON.FeatureCollection | null>(null);
  const [boundaryState, setBoundaryState] = useState<BoundaryState>("loading");
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [activeTopic, setActiveTopic] = useState<ChiayiTopicId>("weatherForecastPoints");
  const [weather, setWeather] = useState<WeatherForecastData | null>(null);
  const [weatherError, setWeatherError] = useState<unknown>(null);
  const [waterWeek, setWaterWeek] = useState<ChiayiWaterWeekData | null>(null);
  const [waterError, setWaterError] = useState<unknown>(null);
  const [waterLoadState, setWaterLoadState] = useState<TopicLoadState>("idle");
  const [transportWeek, setTransportWeek] = useState<ChiayiPublicTransportWeekData | null>(null);
  const [transportError, setTransportError] = useState<unknown>(null);
  const [transportLoadState, setTransportLoadState] = useState<TopicLoadState>("idle");
  const [trafficWeek, setTrafficWeek] = useState<ChiayiTrafficWeekData | null>(null);
  const [trafficError, setTrafficError] = useState<unknown>(null);
  const [trafficLoadState, setTrafficLoadState] = useState<TopicLoadState>("idle");
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [weatherTimeIndex, setWeatherTimeIndex] = useState(0);
  const [weekTimeIndex, setWeekTimeIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [observationOpen, setObservationOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= 680);
  const observationHeadingRef = useRef<HTMLHeadingElement>(null);
  const topicRequestsRef = useRef<Partial<Record<ChiayiTopicId, Promise<unknown>>>>({});
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBoundaryState("loading");
    setWeatherError(null);
    void (async () => {
      try {
        const nextBoundary = await fetchChiayiBoundary(controller.signal);
        if (!active) return;
        setBoundary(nextBoundary);
        setBoundaryState("ready");
        const points = buildWeatherQueryPoints(nextBoundary);
        try {
          const nextWeather = await fetchChiayiWeatherForecast({ points, boundary: nextBoundary, signal: controller.signal });
          if (!active) return;
          setWeather(nextWeather);
          setSelectedPointId(nextWeather.points[0]?.pointId ?? null);
          setWeatherTimeIndex(0);
        } catch (error) {
          if (!active || (error instanceof Error && error.name === "WeatherLoaderError" && "aborted" === (error as { code?: string }).code)) return;
          setWeatherError(error);
        }
      } catch (error) {
        if (!active || (error instanceof Error && error.name === "BoundaryLoaderError" && "aborted" === (error as { code?: string }).code)) return;
        setBoundaryState("error");
        setBoundaryError(shortWeatherError(error));
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!boundary || activeTopic === "weatherForecastPoints") return;
    let active = true;
    if (activeTopic === "waterRain" && (waterWeek || waterLoadState === "loading")) return;
    if (activeTopic === "publicTransport" && (transportWeek || transportLoadState === "loading")) return;
    if (activeTopic === "trafficFlow" && (trafficWeek || trafficLoadState === "loading")) return;
    const existingRequest = topicRequestsRef.current[activeTopic];
    let request: Promise<unknown>;
    if (existingRequest) {
      request = existingRequest;
    } else if (activeTopic === "waterRain") {
      request = fetchChiayiWaterWeekData(boundary);
    } else if (activeTopic === "publicTransport") {
      request = fetchChiayiPublicTransportWeekData(boundary);
    } else {
      request = fetchChiayiTrafficWeekData(boundary);
    }
    if (!existingRequest) topicRequestsRef.current[activeTopic] = request;
    void (async () => {
      try {
        if (activeTopic === "waterRain") {
          setWaterLoadState("loading");
          setWaterError(null);
          const nextWater = await request as ChiayiWaterWeekData;
          if (!active) return;
          setWaterWeek(nextWater);
          setWeekTimeIndex(weekCursorMax(nextWater, WATER_STEP_SECONDS));
          setWaterLoadState("ready");
          return;
        }
        if (activeTopic === "publicTransport") {
          setTransportLoadState("loading");
          setTransportError(null);
          const nextTransport = await request as ChiayiPublicTransportWeekData;
          if (!active) return;
          setTransportWeek(nextTransport);
          setWeekTimeIndex(weekCursorMax(nextTransport, BUS_STEP_SECONDS));
          setTransportLoadState("ready");
          return;
        }
        setTrafficLoadState("loading");
        setTrafficError(null);
        const nextTraffic = await request as ChiayiTrafficWeekData;
        if (!active) return;
        setTrafficWeek(nextTraffic);
        setWeekTimeIndex(weekCursorMax(nextTraffic, TRAFFIC_STEP_SECONDS));
        setTrafficLoadState("ready");
      } catch (error) {
        if (!active) return;
        if (activeTopic === "waterRain") {
          setWaterError(error);
          setWaterLoadState("error");
        } else if (activeTopic === "publicTransport") {
          setTransportError(error);
          setTransportLoadState("error");
        } else {
          setTrafficError(error);
          setTrafficLoadState("error");
        }
      } finally {
        if (topicRequestsRef.current[activeTopic] === request) delete topicRequestsRef.current[activeTopic];
      }
    })();
    return () => {
      active = false;
    };
  }, [activeTopic, boundary]);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 680);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const weatherState: WeatherState = resolveWeatherDisplayState(weather, weatherError !== null, clockMs);
  const selectedPoint = weather?.points.find((point) => point.pointId === selectedPointId) ?? weather?.points[0];
  const selectedValue = selectedPoint ? forecastValue(selectedPoint, weatherTimeIndex) : null;
  const timeCount = selectedPoint?.hourly.length ?? 0;
  const displayedWeatherTimeIndex = timeCount > 0 ? Math.min(weatherTimeIndex, timeCount - 1) : 0;
  const firstForecast = selectedPoint?.hourly[0];
  const lastForecast = selectedPoint && timeCount > 0 ? selectedPoint.hourly[timeCount - 1] : undefined;
  const activeWeek = activeTopic === "waterRain"
    ? waterWeek
    : activeTopic === "publicTransport"
      ? transportWeek
      : activeTopic === "trafficFlow"
        ? trafficWeek
        : null;
  const activeStepSeconds = activeTopic === "waterRain"
    ? WATER_STEP_SECONDS
    : activeTopic === "publicTransport"
      ? BUS_STEP_SECONDS
      : TRAFFIC_STEP_SECONDS;
  const activeWeekMax = activeWeek ? weekCursorMax(activeWeek, activeStepSeconds) : 0;
  const displayedWeekTimeIndex = Math.min(weekTimeIndex, activeWeekMax);
  const selectedWeekTimestamp = activeWeek
    ? weekCursorTimestamp(activeWeek.windowStartAt, displayedWeekTimeIndex, activeStepSeconds)
    : 0;
  const selectedWeekDate = selectedWeekTimestamp > 0
    ? taiwanDateKey(new Date(selectedWeekTimestamp * 1000))
    : null;
  const waterFrame = waterWeek ? waterFrameAtTime(waterWeek, selectedWeekTimestamp) : null;
  const selectedTrafficDay = trafficWeek ? trafficDayAtTime(trafficWeek, selectedWeekTimestamp) : null;
  const displayedTrafficSlot = selectedWeekTimestamp > 0 ? trafficSlotAtTimestamp(selectedWeekTimestamp) : 0;
  const selectedBusPoints = transportWeek && boundary
    ? busPositionsAtTime(transportWeek, selectedWeekTimestamp, boundary)
    : [];
  const selectedTransport: ChiayiTransportFrame | null = transportWeek
    ? { routes: transportWeek.routes, buses: selectedBusPoints }
    : null;
  const meta = TOPIC_META[activeTopic];
  const activeLoadState = activeTopic === "weatherForecastPoints" ? weatherState : activeTopic === "waterRain" ? waterLoadState : activeTopic === "publicTransport" ? transportLoadState : trafficLoadState;
  const statusTone = boundaryState === "error" || activeLoadState === "error" ? "error" : activeLoadState === "loading" || (activeTopic === "weatherForecastPoints" && weatherState === "stale") ? "warning" : "";
  const statusText = boundaryState === "loading"
    ? "正在取得嘉義市界線"
    : boundaryState === "error"
      ? "嘉義市界線無法載入"
      : activeLoadState === "loading"
        ? `正在取得${meta.title.replace("嘉義市", "")}資料`
        : activeLoadState === "error"
          ? `目前沒有${meta.title.replace("嘉義市", "")}資料`
          : activeTopic === "weatherForecastPoints" && weatherState === "stale"
            ? "天氣模型資料可能已過期"
            : meta.title;
  const waterStations = allWaterStations(waterFrame);
  const latestWater = latestStationObservedAt(waterStations);
  const trafficTime = selectedWeekTimestamp > 0 ? formatTaiwanTime(new Date(selectedWeekTimestamp * 1000).toISOString()) : "等待資料";
  const selectPoint = (pointId: string, moveFocus = false) => {
    setSelectedPointId(pointId);
    if (moveFocus) window.requestAnimationFrame(() => observationHeadingRef.current?.focus());
  };
  const observationOpenForView = !isNarrow || observationOpen;
  const rangeMax = activeTopic === "weatherForecastPoints" ? Math.max(0, timeCount - 1) : activeWeekMax;
  const rangeValue = activeTopic === "weatherForecastPoints" ? displayedWeatherTimeIndex : displayedWeekTimeIndex;
  const rangeIsDisabled = activeLoadState !== "ready" || rangeMax <= 0;
  const rangeLabel = activeTopic === "weatherForecastPoints"
    ? "預報有效時間"
    : activeTopic === "waterRain"
      ? "水與雨七日回放"
      : activeTopic === "publicTransport"
        ? "公車七日回放"
        : "交通七日回放";
  const selectedTimeLabel = selectedWeekTimestamp > 0
    ? formatTaiwanTime(new Date(selectedWeekTimestamp * 1000).toISOString())
    : "等待資料";
  const hasSelectedTopicData = activeTopic === "waterRain"
    ? waterStations.length > 0
    : activeTopic === "publicTransport"
      ? (selectedWeekDate ? transportWeek?.availableDates.includes(selectedWeekDate) === true : false)
      : selectedTrafficDay !== null;
  const rangeValueLabel = activeTopic === "weatherForecastPoints"
    ? (selectedValue ? formatTaiwanTime(selectedValue.validAt) : "等待資料")
    : `${selectedTimeLabel}${hasSelectedTopicData ? "" : "（該時段無資料）"}`;
  const rangeStartLabel = activeTopic === "weatherForecastPoints"
    ? (firstForecast ? formatTaiwanTime(firstForecast.validAt) : "目前")
    : activeWeek
      ? formatTaiwanTime(activeWeek.windowStartAt)
      : "等待資料";
  const rangeEndLabel = activeTopic === "weatherForecastPoints"
    ? (lastForecast ? formatTaiwanTime(lastForecast.validAt) : "未來 48 小時")
    : activeWeek
      ? formatTaiwanTime(activeWeek.windowEndAt)
      : "等待資料";

  useEffect(() => {
    setIsPlaying(false);
  }, [activeTopic]);

  useEffect(() => {
    if (!isPlaying || activeLoadState !== "ready" || rangeMax <= 0) return;
    const stride = activeTopic === "weatherForecastPoints"
      ? 1
      : activeTopic === "waterRain"
        ? 1
        : activeTopic === "publicTransport"
          ? 3
          : 6;
    const timer = window.setInterval(() => {
      if (activeTopic === "weatherForecastPoints") {
        setWeatherTimeIndex((current) => current >= rangeMax ? 0 : Math.min(rangeMax, current + stride));
      } else {
        setWeekTimeIndex((current) => current >= rangeMax ? 0 : Math.min(rangeMax, current + stride));
      }
    }, 300);
    return () => window.clearInterval(timer);
  }, [activeLoadState, activeTopic, isPlaying, rangeMax]);

  return (
    <div className="chiayi-student-shell" data-testid="chiayi-student-shell">
      <style>{CHIAYI_STUDENT_CSS}</style>
      <header className="chiayi-student-header">
        <div>
          <div className="chiayi-student-kicker">Mini Taiwan Pulse · Student MVP</div>
          <h1 className="chiayi-student-title">{meta.title}</h1>
          <p className="chiayi-student-subtitle">{meta.subtitle}</p>
        </div>
        <div className="chiayi-student-status" data-testid="chiayi-topic-status" role="status" aria-live="polite">
          <span className={`chiayi-student-status-dot ${statusTone}`} aria-hidden="true" />
          <span>{statusText}</span>
        </div>
      </header>

      <aside className="chiayi-student-education" aria-label="嘉義市學習面板">
        <div className="chiayi-student-education-inner">
          <div className="chiayi-student-region-topic-row">
            <section className="chiayi-student-card" data-testid="chiayi-region-status" aria-labelledby="chiayi-region-heading">
              <span className="chiayi-student-label">區域</span>
              <h2 id="chiayi-region-heading" className="chiayi-student-region-name">嘉義市</h2>
              <p className="chiayi-student-region-note">嘉義縣不在本次範圍。</p>
              <span className={`chiayi-student-boundary-status ${boundaryState === "error" ? "error" : ""}`} data-testid="chiayi-boundary-status">
                <span aria-hidden="true">{boundaryState === "ready" ? "●" : "○"}</span>
                {boundaryState === "ready" ? "正式市界已載入" : boundaryState === "loading" ? "正式市界載入中" : "正式市界無法載入"}
              </span>
            </section>

            <section className="chiayi-student-card" data-testid="chiayi-topic-selector" aria-labelledby="chiayi-topic-heading">
              <label id="chiayi-topic-heading" className="chiayi-student-label" htmlFor="chiayi-topic">觀察主題</label>
              <select id="chiayi-topic" className="chiayi-student-topic-select" value={activeTopic} onChange={(event) => setActiveTopic(event.target.value as ChiayiTopicId)}>
                <option value="weatherForecastPoints">☁️ 雲與天氣模型預報</option>
                <option value="waterRain">💧 水與雨</option>
                <option value="publicTransport">🚌 嘉義市公共運輸</option>
                <option value="trafficFlow">🚗 交通流動與壅塞</option>
              </select>
              <p className="chiayi-student-topic-note">{meta.note}</p>
            </section>
          </div>

          <section className="chiayi-student-card" data-testid="chiayi-observation-card" aria-labelledby="chiayi-observation-heading">
            <div className="chiayi-student-observation-header">
              <h2 id="chiayi-observation-heading" ref={observationHeadingRef} tabIndex={-1}>觀察說明</h2>
              {isNarrow && (
                <button type="button" className="chiayi-student-toggle" aria-expanded={observationOpen} onClick={() => setObservationOpen((open) => !open)}>
                  {observationOpen ? "收合" : "展開"}
                </button>
              )}
            </div>
            {observationOpenForView && (
              <div className="chiayi-student-observation-content">
                {activeTopic === "weatherForecastPoints" && (
                  <>
                    <p className="chiayi-student-observation-intro">先選一個模型格網中心，再移動下方的「預報有效時間」。最後選另一個位置比較。來源會把座標吸附到可用的模型格網，所以模型點不是測站。</p>
                    {weather?.points.length ? (
                      <div className="chiayi-student-point-list" data-testid="chiayi-point-list" aria-label="模型格網位置">
                        {weather.points.map((point) => (
                          <button key={point.pointId} type="button" className="chiayi-student-point-button" aria-pressed={point.pointId === selectedPoint?.pointId} onClick={() => selectPoint(point.pointId, true)}>
                            {point.label}
                            <small>{point.sourceGridLatitude.toFixed(3)}°N · {point.sourceGridLongitude.toFixed(3)}°E</small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {weatherState === "loading" && <p className="chiayi-student-meta">正在準備模型預報點，地圖仍可拖曳與縮放。</p>}
                    {weatherState === "error" && <p className="chiayi-student-error">目前沒有天氣模型資料。{shortWeatherError(weatherError)}</p>}
                    {selectedPoint && selectedValue && weatherState !== "error" && (
                      <>
                        <div className="chiayi-student-value-grid" aria-label="選取位置的天氣預報數值">
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">溫度</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.temperature2mC, "°C")}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">降水量／逐時</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.precipitationMm, "mm")}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">雨量強度</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.rainMm, "mm")}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">雲量</span><strong className="chiayi-student-value-number">{formatNumber(selectedValue.cloudCoverPct, "%", 0)}</strong></div>
                        </div>
                        <p className="chiayi-student-meta"><strong>{selectedPoint.label}</strong> · 模型格網中心<br />預報有效時間：<strong>{formatTaiwanTime(selectedValue.validAt)}</strong><br />資料取得時間：{formatFetchedAt(weather?.fetchedAt ?? "")}<br />資料角色：模型預報（不是測站觀測）</p>
                      </>
                    )}
                  </>
                )}

                {activeTopic === "waterRain" && (
                  <>
                    <p className="chiayi-student-observation-intro">用近七日、每小時一格的資料回放，比較雨量、河川水位與水資源 IoT。三組來源各自保留原始觀測時間；沒有資料的時段不補 0。</p>
                    {waterLoadState === "loading" && <p className="chiayi-student-meta">正在讀取近七日雨量、河川水位與水資源 IoT。</p>}
                    {waterLoadState === "error" && <p className="chiayi-student-error">目前沒有水與雨資料。{shortTopicError(waterError)}</p>}
                    {waterWeek && waterLoadState === "ready" && (
                      <>
                        <div className="chiayi-student-value-grid" aria-label="水與雨資料摘要">
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">雨量測站</span><strong className="chiayi-student-value-number">{waterFrame?.rainGauge.length ?? 0}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">河川水位</span><strong className="chiayi-student-value-number">{waterFrame?.riverLevel.length ?? 0}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">IoT 河川</span><strong className="chiayi-student-value-number">{waterFrame?.iotRiver.length ?? 0}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">界內觀測點</span><strong className="chiayi-student-value-number">{waterStations.length}</strong></div>
                        </div>
                        <p className="chiayi-student-meta">回放時間：<strong>{selectedTimeLabel}</strong><br />最新原始觀測：{latestWater ? formatTaiwanTime(latestWater) : "此時段無"}<br />資料取得：{formatFetchedAt(waterWeek.fetchedAt)}<br />資料日期：{waterWeek.availableDates.length}/7 天；資料角色：真實來源近七日回放</p>
                        {waterStations.length === 0 && <p className="chiayi-student-meta">這個時間格沒有界內觀測值，請移動滑桿查看其他時段。</p>}
                        {waterWeek.missingDates.length > 0 && <p className="chiayi-student-error">水與雨缺少日期：{waterWeek.missingDates.join("、")}</p>}
                        {waterWeek.partialErrors.length > 0 && <p className="chiayi-student-error">部分來源提醒：{waterWeek.partialErrors.join("；")}</p>}
                      </>
                    )}
                  </>
                )}

                {activeTopic === "publicTransport" && (
                  <>
                    <p className="chiayi-student-observation-intro">先看路線如何穿過嘉義市，再用近七日可取得的歷史軌跡回放車輛移動。路線是靜態幾何；缺少的日期不補軌跡。</p>
                    {transportLoadState === "loading" && <p className="chiayi-student-meta">正在讀取近七日嘉義市公車歷史軌跡。</p>}
                    {transportLoadState === "error" && <p className="chiayi-student-error">目前沒有公共運輸資料。{shortTopicError(transportError)}</p>}
                    {transportWeek && transportLoadState === "ready" && (
                      <>
                        <div className="chiayi-student-value-grid" aria-label="公共運輸資料摘要">
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">界內路線</span><strong className="chiayi-student-value-number">{transportWeek.routes.length}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">此時車輛</span><strong className="chiayi-student-value-number">{selectedBusPoints.length}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">可回放日期</span><strong className="chiayi-student-value-number">{transportWeek.availableDates.length}/7</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">資料粒度</span><strong className="chiayi-student-value-number">10 分鐘</strong></div>
                        </div>
                        <p className="chiayi-student-meta">回放時間：<strong>{selectedTimeLabel}</strong><br />資料取得：{formatFetchedAt(transportWeek.fetchedAt)}<br />資料角色：路線資產＋真實歷史軌跡；目前端點另作最新快照</p>
                        {transportWeek.missingDates.length > 0 && <p className="chiayi-student-error">公車缺少日期：{transportWeek.missingDates.join("、")}</p>}
                        {transportWeek.partialErrors.length > 0 && <p className="chiayi-student-error">部分資料提醒：{transportWeek.partialErrors.join("；")}</p>}
                      </>
                    )}
                  </>
                )}

                {activeTopic === "trafficFlow" && (
                  <>
                    <p className="chiayi-student-observation-intro">用下方滑桿選擇近七日的五分鐘資料槽。道路幾何來自已部署的 PMTiles，壅塞等級來自 Supabase 時序；道路事件會依同一時間判斷是否有效。</p>
                    {trafficLoadState === "loading" && <p className="chiayi-student-meta">正在讀取近七日省道路況時序與道路事件。</p>}
                    {trafficLoadState === "error" && <p className="chiayi-student-error">目前沒有交通資料。{shortTopicError(trafficError)}</p>}
                    {trafficWeek && trafficLoadState === "ready" && (
                      <>
                        <div className="chiayi-student-value-grid" aria-label="交通資料摘要">
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">省道路段</span><strong className="chiayi-student-value-number">{selectedTrafficDay?.congestion?.sections.length ?? 0}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">道路事件</span><strong className="chiayi-student-value-number">{selectedTrafficDay?.events.length ?? 0}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">目前資料槽</span><strong className="chiayi-student-value-number">{trafficTime}</strong></div>
                          <div className="chiayi-student-value"><span className="chiayi-student-value-label">資料粒度</span><strong className="chiayi-student-value-number">5 分鐘</strong></div>
                        </div>
                        <p className="chiayi-student-meta">資料日期：<strong>{selectedWeekDate ?? "等待資料"}</strong><br />資料取得：{formatFetchedAt(trafficWeek.fetchedAt)}<br />資料角色：真實來源近七日當日時序＋事件；不代表全市所有道路</p>
                        {selectedTrafficDay === null && <p className="chiayi-student-meta">這個日期沒有可用交通資料，請移動滑桿查看其他日期。</p>}
                        {trafficWeek.missingDates.length > 0 && <p className="chiayi-student-error">交通缺少日期：{trafficWeek.missingDates.join("、")}</p>}
                        {trafficWeek.partialErrors.length > 0 && <p className="chiayi-student-error">部分資料提醒：{trafficWeek.partialErrors.join("；")}</p>}
                      </>
                    )}
                  </>
                )}
                {boundaryError && <p className="chiayi-student-error">正式市界載入失敗，為避免誤導，本次不顯示區域資料。{boundaryError}</p>}
              </div>
            )}
          </section>
        </div>
      </aside>

      <main className="chiayi-student-map-stage" data-testid="chiayi-map-stage" aria-label={`${meta.title}地圖`}>
        <MultiTopicMapCanvas boundary={boundary} activeTopic={activeTopic} weather={weatherState === "error" ? null : weather} water={waterLoadState === "ready" ? waterFrame : null} transport={transportLoadState === "ready" ? selectedTransport : null} transportWeek={transportLoadState === "ready" ? transportWeek : null} transportTimestamp={selectedWeekTimestamp} traffic={trafficLoadState === "ready" ? selectedTrafficDay : null} weatherTimeIndex={displayedWeatherTimeIndex} trafficSlot={displayedTrafficSlot} onSelectPoint={selectPoint} />
        <div className="chiayi-student-map-legend" aria-hidden="true">
          <strong>{meta.legendTitle}</strong>
          <span>{meta.legendNote}</span>
        </div>
        {boundaryState === "error" && <div className="chiayi-student-map-message">正式嘉義市界線無法載入，為避免把候選範圍當成市界，這次不畫界線與主題資料。</div>}
        <div className="chiayi-student-attribution">
          底圖 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · {activeTopic === "weatherForecastPoints" ? <>Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a></> : <>Data by Pulse read-only APIs · geometry via deployed PMTiles</>}
        </div>
      </main>

      <section className="chiayi-student-time-controller" data-testid="chiayi-time-controller" aria-label={rangeLabel}>
        <div className="chiayi-student-time-inner">
          <label className="chiayi-student-time-label" htmlFor="chiayi-topic-time">{rangeLabel}</label>
          <output className="chiayi-student-time-value" htmlFor="chiayi-topic-time">{rangeValueLabel}</output>
          <div className="chiayi-student-time-actions" aria-label="時間回放控制">
            <button type="button" className="chiayi-student-time-action" data-testid="chiayi-playback-toggle" aria-pressed={isPlaying} disabled={rangeIsDisabled} onClick={() => setIsPlaying((playing) => !playing)}>{isPlaying ? "暫停" : "播放"}</button>
            <button type="button" className="chiayi-student-time-action" data-testid="chiayi-playback-reset" disabled={rangeIsDisabled} onClick={() => activeTopic === "weatherForecastPoints" ? setWeatherTimeIndex(0) : setWeekTimeIndex(0)}>從頭</button>
          </div>
          <input
            id="chiayi-topic-time"
            className="chiayi-student-time-range"
            type="range"
            min={0}
            max={rangeMax}
            value={rangeValue}
            disabled={rangeIsDisabled}
            onChange={(event) => activeTopic === "weatherForecastPoints" ? setWeatherTimeIndex(Number(event.target.value)) : setWeekTimeIndex(Number(event.target.value))}
            aria-label={rangeLabel}
          />
          <div className="chiayi-student-time-ends"><span>{rangeStartLabel}</span><span>{rangeEndLabel}</span></div>
        </div>
      </section>

      <p className="chiayi-student-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="chiayi-live-region">
        {activeTopic === "weatherForecastPoints" && selectedPoint && selectedValue ? `${selectedPoint.label}，${formatTaiwanTime(selectedValue.validAt)}，溫度 ${formatNumber(selectedValue.temperature2mC, "°C")}，雲量 ${formatNumber(selectedValue.cloudCoverPct, "%", 0)}，資料角色為模型預報。` : activeTopic === "waterRain" && waterWeek ? `水與雨七日回放，${waterStations.length} 個嘉義市界內觀測點，時間 ${selectedTimeLabel}。` : activeTopic === "publicTransport" && transportWeek ? `公共運輸七日回放，${transportWeek.routes.length} 條界內路線，${selectedBusPoints.length} 台車輛，時間 ${selectedTimeLabel}。` : activeTopic === "trafficFlow" && trafficWeek ? `交通七日回放，${selectedTrafficDay?.congestion?.sections.length ?? 0} 個省道路段，${selectedTrafficDay?.events.length ?? 0} 個道路事件，時間 ${trafficTime}。` : statusText}
      </p>
    </div>
  );
}
