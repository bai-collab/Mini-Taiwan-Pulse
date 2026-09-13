import type { LayerVisibility } from "../types";

export type TrimmedPulseLayerKey = keyof LayerVisibility;

/**
 * FullPulseApp 的產品層白名單。
 *
 * 這不是權限設定，也不取代 layerManifest；manifest 仍保留完整層目錄，
 * 這份設定只決定精簡版可以顯示與啟用哪些層。
 */
export const trimmedPulseLayerAllowlist: ReadonlySet<TrimmedPulseLayerKey> = new Set<TrimmedPulseLayerKey>([
  // 底圖／地形
  "countyBoundary",
  "contour25k",
  "contourDtm20",
  "hillshade",

  // 交通
  "flights",
  "ships",
  "rail",
  "stationsTRA",
  "stationsTHSR",
  "busLive",
  "busIntercityLive",

  // 災害
  "earthquakes",
  "earthquakeReplay",
  "activeFaults",
  "mountainRescueIncidents",

  // 環境
  "weatherStations",
  "cwaRadarImagery",

  // 水資源
  "waterFacilities",
  "waterMonitorStations",
  "waterReservoirs",
  "marineObservationCwa",
  "marineObservationIsohe",
  "groundwaterWells",
  "rainGauge",
  "riverLevel",
  "floodSensor",
  "iotWraRiver",
  "iotWraStructure",
  "taipeiSewer",
  "taipeiEvacuate",
  "taipeiPumb",
  "waterBasins",
  "waterRivers",
  "waterLevees",
  "waterCanals",
  "waterProtectionZones",
  "waterDetentionBasins",
  "groundwater",
  "lakesPondsOsm",
  "waterFloodExtreme",
  "floodSensorIsochrone",
  "precipRaster",
]);

export const isTrimmedPulseLayer = (key: string): key is TrimmedPulseLayerKey =>
  trimmedPulseLayerAllowlist.has(key as TrimmedPulseLayerKey);

/** FullPulseApp 精簡版不掛載的側欄／工具入口。元件檔仍保留，方便其他 surface 使用。 */
export const trimmedPulseUi = {
  showSatellite: false,
  showPropertyValue: false,
  showIntel: false,
  showMonitor: false,
  showMember: false,
  showAdmin: false,
  showChat: false,
  showWorld: false,
  showJapan: false,
  showStatistics: false,
  showDataSourceBrowser: false,
} as const;

export type TrimmedPulseCoverage = {
  label: string;
  reason: string;
};

const UNSUPPORTED_COVERAGE: Partial<Record<TrimmedPulseLayerKey, TrimmedPulseCoverage>> = {
  taipeiSewer: {
    label: "不可（Taipei-only）",
    reason: "資料只涵蓋臺北市，嘉義不適用。",
  },
  taipeiEvacuate: {
    label: "不可（Taipei-only）",
    reason: "資料只涵蓋臺北市，嘉義不適用。",
  },
  taipeiPumb: {
    label: "不可（Taipei-only）",
    reason: "資料只涵蓋臺北市，嘉義不適用。",
  },
  floodSensorIsochrone: {
    label: "不可（雙北）",
    reason: "時圈資料只涵蓋雙北，嘉義不適用。",
  },
};

export function getTrimmedPulseCoverage(key: TrimmedPulseLayerKey): TrimmedPulseCoverage | undefined {
  return UNSUPPORTED_COVERAGE[key];
}

type TrimmedPulseLayerMode = "time-aware" | "scoped-replay" | "live" | "snapshot";

const LAYER_MODES: Partial<Record<TrimmedPulseLayerKey, TrimmedPulseLayerMode>> = {
  flights: "time-aware",
  ships: "time-aware",
  rail: "time-aware",
  busLive: "time-aware",
  busIntercityLive: "time-aware",
  // 原生 EarthquakeReplayPanel 使用自己的 scoped replay clock，不冒充全域 timeStore。
  earthquakeReplay: "scoped-replay",
  cwaRadarImagery: "time-aware",

  weatherStations: "live",
  stationsTRA: "live",
  stationsTHSR: "live",
  earthquakes: "live",
  activeFaults: "snapshot",
  mountainRescueIncidents: "live",
  waterFacilities: "snapshot",
  waterMonitorStations: "live",
  waterReservoirs: "live",
  marineObservationCwa: "live",
  marineObservationIsohe: "live",
  groundwaterWells: "snapshot",
  rainGauge: "live",
  riverLevel: "live",
  floodSensor: "live",
  iotWraRiver: "live",
  iotWraStructure: "live",
  taipeiSewer: "snapshot",
  taipeiEvacuate: "snapshot",
  taipeiPumb: "snapshot",
  waterBasins: "snapshot",
  waterRivers: "snapshot",
  waterLevees: "snapshot",
  waterCanals: "snapshot",
  waterProtectionZones: "snapshot",
  waterDetentionBasins: "snapshot",
  groundwater: "snapshot",
  lakesPondsOsm: "snapshot",
  waterFloodExtreme: "snapshot",
  floodSensorIsochrone: "snapshot",
  precipRaster: "time-aware",
};

export function getTrimmedPulseLayerMode(key: TrimmedPulseLayerKey): TrimmedPulseLayerMode {
  return LAYER_MODES[key] ?? "snapshot";
}

export function getTrimmedPulseLayerModeLabel(key: TrimmedPulseLayerKey): string {
  switch (getTrimmedPulseLayerMode(key)) {
    case "time-aware":
      return "時間游標";
    case "scoped-replay":
      return "專用回放";
    case "live":
      return "即時";
    default:
      return "快照／靜態";
  }
}
