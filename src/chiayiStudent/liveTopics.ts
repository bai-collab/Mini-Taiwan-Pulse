import { supabaseConfigured } from "../lib/supabase";
import { isCoordinateInsideBoundary } from "./chiayiBoundary";
import {
  fetchRainGaugeDay,
  type RainGaugeDayRow,
} from "../data/rainGaugeLoader";
import {
  fetchRiverLevelDay,
  type RiverLevelDayRow,
} from "../data/riverLevelLoader";
import {
  fetchIotWraRiverDay,
  parseTimeline,
  type IotWraDayRow,
} from "../data/iotWraRiverLoader";
import {
  fetchBusCurrent,
  fetchBusDates,
  fetchBusTrails,
  loadBusRoutesForCity,
} from "../data/busLoader";
import type { BusCity, BusRouteGeometry, BusTrail, TrailPoint } from "../types";
import { interpolatePosition } from "../utils/interpolation";
import {
  fetchRoadCongestionDay,
  type RoadCongestionDayData,
} from "../data/roadCongestionLoader";
import {
  fetchRoadEventsDay,
  type RoadEvent,
} from "../data/roadEventsLoader";

export type ChiayiTopicId =
  | "weatherForecastPoints"
  | "waterRain"
  | "publicTransport"
  | "trafficFlow";

export class ChiayiTopicLoaderError extends Error {
  readonly code: "not-configured" | "network" | "no-data";

  constructor(
    code: ChiayiTopicLoaderError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ChiayiTopicLoaderError";
    this.code = code;
  }
}

export interface ChiayiWaterStation {
  id: string;
  name: string;
  kind: "rainGauge" | "riverLevel" | "iotRiver";
  latitude: number;
  longitude: number;
  observedAt: string;
  value: number | null;
  secondaryValue: number | null;
  unit: string;
  status: string | null;
}

export interface ChiayiWaterData {
  provider: "Pulse Supabase read RPC";
  dataEvidenceMode: "live";
  timeMode: "live";
  date: string;
  fetchedAt: string;
  latestObservedAt: string | null;
  rainGauge: ChiayiWaterStation[];
  riverLevel: ChiayiWaterStation[];
  iotRiver: ChiayiWaterStation[];
  sourceRows: {
    rainGauge: number;
    riverLevel: number;
    iotRiver: number;
  };
  partialErrors: string[];
}

export interface ChiayiBusRouteFeature {
  routeUid: string;
  routeName: string;
  direction: number;
  coordinates: [number, number][];
}

export interface ChiayiBusPoint {
  id: string;
  plateNumber: string;
  routeUid: string | null;
  routeName: string | null;
  direction: number;
  latitude: number;
  longitude: number;
  speedKmh: number;
  observedAt: string;
}

export interface ChiayiPublicTransportData {
  provider: "Pulse route asset + Supabase read RPC";
  dataEvidenceMode: "live";
  timeMode: "live";
  fetchedAt: string;
  latestObservedAt: string | null;
  routes: ChiayiBusRouteFeature[];
  buses: ChiayiBusPoint[];
  partialErrors: string[];
}

export interface ChiayiTrafficEvent {
  id: string;
  source: string;
  title: string;
  roadName: string | null;
  eventType: number | null;
  severity: number | null;
  startTs: number;
  endTs: number | null;
  geometry: GeoJSON.Geometry;
}

export interface ChiayiTrafficData {
  provider: "Pulse Supabase read RPC + deployed Pulse PMTiles geometry";
  dataEvidenceMode: "live";
  timeMode: "replay";
  date: string;
  fetchedAt: string;
  congestion: RoadCongestionDayData | null;
  events: ChiayiTrafficEvent[];
  partialErrors: string[];
}

export interface ChiayiWeekWindow {
  windowStartDate: string;
  windowEndDate: string;
  windowStartAt: string;
  windowEndAt: string;
}

export interface ChiayiWaterFrame {
  timestamp: number;
  date: string;
  rainGauge: ChiayiWaterStation[];
  riverLevel: ChiayiWaterStation[];
  iotRiver: ChiayiWaterStation[];
}

export interface ChiayiWaterWeekData extends ChiayiWeekWindow {
  provider: "Pulse Supabase read RPC";
  dataEvidenceMode: "live";
  timeMode: "replay";
  fetchedAt: string;
  frames: ChiayiWaterFrame[];
  availableDates: string[];
  missingDates: string[];
  partialErrors: string[];
}

export interface ChiayiBusReplayTrail {
  id: string;
  plateNumber: string;
  routeUid: string | null;
  routeName: string | null;
  direction: number;
  path: TrailPoint[];
}

export interface ChiayiPublicTransportWeekData extends ChiayiWeekWindow {
  provider: "Pulse route asset + Supabase read RPC";
  dataEvidenceMode: "live";
  timeMode: "replay";
  fetchedAt: string;
  routes: ChiayiBusRouteFeature[];
  trails: ChiayiBusReplayTrail[];
  liveSnapshot: ChiayiBusPoint[];
  availableDates: string[];
  missingDates: string[];
  partialErrors: string[];
}

export interface ChiayiTrafficWeekData extends ChiayiWeekWindow {
  provider: "Pulse Supabase read RPC + deployed Pulse PMTiles geometry";
  dataEvidenceMode: "live";
  timeMode: "replay";
  fetchedAt: string;
  days: ChiayiTrafficData[];
  availableDates: string[];
  missingDates: string[];
  partialErrors: string[];
}

export function taiwanDateKey(now = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

export function taiwanDateStartTimestamp(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`) / 1000;
}

export function rollingTaiwanDates(
  endDate = taiwanDateKey(),
  days = 7,
): string[] {
  const count = Math.max(1, Math.floor(days));
  return Array.from({ length: count }, (_, index) =>
    taiwanDateKey(new Date((taiwanDateStartTimestamp(endDate) - (count - index - 1) * 86400) * 1000)),
  );
}

export function buildChiayiWeekWindow(
  endDate = taiwanDateKey(),
  now = new Date(),
  days = 7,
): ChiayiWeekWindow {
  const dates = rollingTaiwanDates(endDate, days);
  const windowStartDate = dates[0] ?? endDate;
  const nowDate = taiwanDateKey(now);
  const endTimestamp = endDate === nowDate
    ? Math.floor(now.getTime() / 1000)
    : taiwanDateStartTimestamp(endDate) + 86400 - 1;
  return {
    windowStartDate,
    windowEndDate: endDate,
    windowStartAt: new Date(taiwanDateStartTimestamp(windowStartDate) * 1000).toISOString(),
    windowEndAt: new Date(endTimestamp * 1000).toISOString(),
  };
}

export function weekCursorTimestamp(
  windowStartAt: string,
  cursor: number,
  stepSeconds: number,
): number {
  const safeCursor = Math.max(0, Math.floor(cursor));
  return Math.floor(Date.parse(windowStartAt) / 1000) + safeCursor * Math.max(1, stepSeconds);
}

export function weekCursorMax(window: ChiayiWeekWindow, stepSeconds: number): number {
  return Math.max(
    0,
    Math.floor((Date.parse(window.windowEndAt) - Date.parse(window.windowStartAt)) / 1000 / Math.max(1, stepSeconds)),
  );
}

function requireSupabase(topicLabel: string): void {
  if (!supabaseConfigured) {
    throw new ChiayiTopicLoaderError(
      "not-configured",
      `${topicLabel}需要 Supabase read-only 設定；目前沒有 VITE_SUPABASE_URL／VITE_SUPABASE_ANON_KEY。`,
    );
  }
}

function validCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}

function latestById<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  observedAtOf: (row: T) => string,
): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const id = idOf(row);
    const previous = latest.get(id);
    if (!previous || Date.parse(observedAtOf(row)) >= Date.parse(observedAtOf(previous))) {
      latest.set(id, row);
    }
  }
  return [...latest.values()];
}

function latestObservedAt(values: readonly string[]): string | null {
  const valid = values
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.ms))
    .sort((a, b) => b.ms - a.ms);
  return valid[0]?.value ?? null;
}

function withinBoundary(
  boundary: GeoJSON.FeatureCollection,
  latitude: number,
  longitude: number,
): boolean {
  return validCoordinate(latitude, longitude)
    && isCoordinateInsideBoundary(boundary, latitude, longitude);
}

function rainStationFromRow(row: RainGaugeDayRow): ChiayiWaterStation {
  return {
    id: row.station_id,
    name: row.station_name ?? row.station_id,
    kind: "rainGauge",
    latitude: row.lat,
    longitude: row.lng,
    observedAt: row.observed_at,
    value: row.precipitation_1hr,
    secondaryValue: row.precipitation_24hr,
    unit: "mm／1 小時",
    status: row.county && row.town ? `${row.county} ${row.town}` : null,
  };
}

function riverStationFromRow(row: RiverLevelDayRow): ChiayiWaterStation {
  return {
    id: row.station_id,
    name: row.station_name ?? row.station_id,
    kind: "riverLevel",
    latitude: row.lat,
    longitude: row.lng,
    observedAt: row.observed_at,
    value: row.water_level_m,
    secondaryValue: null,
    unit: "m 水位",
    status: row.check_result == null ? null : `檢核碼 ${row.check_result}`,
  };
}

function iotStationFromPoint(
  row: IotWraDayRow,
  observedAt: string,
  value: number,
): ChiayiWaterStation {
  return {
    id: row.iow_station_id,
    name: row.name,
    kind: "iotRiver",
    latitude: row.lat,
    longitude: row.lng,
    observedAt,
    value,
    secondaryValue: null,
    unit: row.si_unit ?? "m",
    status: row.basin_name || row.county_name,
  };
}

function rainStations(
  rows: readonly RainGaugeDayRow[],
  boundary: GeoJSON.FeatureCollection,
): ChiayiWaterStation[] {
  const filtered = rows.filter((row) => withinBoundary(boundary, row.lat, row.lng));
  return latestById(filtered, (row) => row.station_id, (row) => row.observed_at)
    .map(rainStationFromRow);
}

function riverStations(
  rows: readonly RiverLevelDayRow[],
  boundary: GeoJSON.FeatureCollection,
): ChiayiWaterStation[] {
  const filtered = rows.filter((row) => withinBoundary(boundary, row.lat, row.lng));
  return latestById(filtered, (row) => row.station_id, (row) => row.observed_at)
    .map(riverStationFromRow);
}

function iotRiverStations(
  rows: readonly IotWraDayRow[],
  boundary: GeoJSON.FeatureCollection,
): ChiayiWaterStation[] {
  const filtered = rows.filter((row) => {
    const isObservedLevel = row.measurement_name == null || !row.measurement_name.includes("預測");
    return isObservedLevel && withinBoundary(boundary, row.lat, row.lng);
  });

  const latest = new Map<string, { row: IotWraDayRow; observedAt: string; value: number }>();
  for (const row of filtered) {
    const points = parseTimeline(row.timeline);
    const point = points[points.length - 1];
    if (!point) continue;
    const observedAt = new Date(point.t * 1000).toISOString();
    const previous = latest.get(row.iow_station_id);
    if (!previous || point.t >= Date.parse(previous.observedAt) / 1000) {
      latest.set(row.iow_station_id, { row, observedAt, value: point.v });
    }
  }

  return [...latest.values()].map(({ row, observedAt, value }) => iotStationFromPoint(row, observedAt, value));
}

export async function fetchChiayiWaterData(
  boundary: GeoJSON.FeatureCollection,
  date = taiwanDateKey(),
): Promise<ChiayiWaterData> {
  requireSupabase("水與雨資料");
  const results = await Promise.allSettled([
    fetchRainGaugeDay(date),
    fetchRiverLevelDay(date),
    fetchIotWraRiverDay(date),
  ]);

  const partialErrors: string[] = [];
  const rainRows = results[0]?.status === "fulfilled" ? results[0].value : [];
  const riverRows = results[1]?.status === "fulfilled" ? results[1].value : [];
  const iotRows = results[2]?.status === "fulfilled" ? results[2].value : [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const labels = ["雨量", "河川水位", "IoT 河川"];
      partialErrors.push(`${labels[index]}：${result.reason instanceof Error ? result.reason.message : "服務回應失敗"}`);
    }
  });

  if (rainRows.length === 0 && riverRows.length === 0 && iotRows.length === 0) {
    throw new ChiayiTopicLoaderError("network", partialErrors.join("；") || "水與雨服務沒有回應");
  }

  const rainGauge = rainStations(rainRows, boundary);
  const riverLevel = riverStations(riverRows, boundary);
  const iotRiver = iotRiverStations(iotRows, boundary);
  return {
    provider: "Pulse Supabase read RPC",
    dataEvidenceMode: "live",
    timeMode: "live",
    date,
    fetchedAt: new Date().toISOString(),
    latestObservedAt: latestObservedAt([
      ...rainGauge,
      ...riverLevel,
      ...iotRiver,
    ].map((station) => station.observedAt)),
    rainGauge,
    riverLevel,
    iotRiver,
    sourceRows: {
      rainGauge: rainRows.length,
      riverLevel: riverRows.length,
      iotRiver: iotRows.length,
    },
    partialErrors,
  };
}

interface WaterDayRows {
  date: string;
  rainGauge: RainGaugeDayRow[];
  riverLevel: RiverLevelDayRow[];
  iotRiver: IotWraDayRow[];
  partialErrors: string[];
}

async function readWaterDayRows(date: string): Promise<WaterDayRows> {
  const results = await Promise.allSettled([
    fetchRainGaugeDay(date),
    fetchRiverLevelDay(date),
    fetchIotWraRiverDay(date),
  ]);
  const labels = ["雨量", "河川水位", "IoT 河川"];
  const partialErrors = results.flatMap((result, index) => result.status === "rejected"
    ? [`${date} ${labels[index]}：${result.reason instanceof Error ? result.reason.message : "服務回應失敗"}`]
    : []);
  return {
    date,
    rainGauge: results[0]?.status === "fulfilled" ? results[0].value : [],
    riverLevel: results[1]?.status === "fulfilled" ? results[1].value : [],
    iotRiver: results[2]?.status === "fulfilled" ? results[2].value : [],
    partialErrors,
  };
}

function timestampFromValue(value: string): number | null {
  const iso = value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}+08:00`;
  const timestamp = Date.parse(iso) / 1000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildStationFrames<T>(
  rows: readonly T[],
  boundary: GeoJSON.FeatureCollection,
  frameTimes: readonly number[],
  observedAtOf: (row: T) => string,
  idOf: (row: T) => string,
  coordinatesOf: (row: T) => [number, number],
  stationOf: (row: T) => ChiayiWaterStation,
): ChiayiWaterStation[][] {
  const ordered = rows
    .map((row) => ({ row, timestamp: timestampFromValue(observedAtOf(row)) }))
    .filter((item): item is { row: T; timestamp: number } => item.timestamp !== null)
    .filter((item) => {
      const [latitude, longitude] = coordinatesOf(item.row);
      return withinBoundary(boundary, latitude, longitude);
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  const latest = new Map<string, T>();
  let cursor = 0;
  return frameTimes.map((frameTime) => {
    while (cursor < ordered.length && ordered[cursor]!.timestamp <= frameTime) {
      const row = ordered[cursor]!.row;
      latest.set(idOf(row), row);
      cursor += 1;
    }
    return [...latest.values()].map(stationOf);
  });
}

function buildIotStationFrames(
  rows: readonly IotWraDayRow[],
  boundary: GeoJSON.FeatureCollection,
  frameTimes: readonly number[],
): ChiayiWaterStation[][] {
  const ordered: Array<{ stationId: string; timestamp: number; station: ChiayiWaterStation }> = [];
  for (const row of rows) {
    const isObservedLevel = row.measurement_name == null || !row.measurement_name.includes("預測");
    if (!isObservedLevel || !withinBoundary(boundary, row.lat, row.lng)) continue;
    for (const point of parseTimeline(row.timeline)) {
      if (!Number.isFinite(point.t) || !Number.isFinite(point.v)) continue;
      ordered.push({
        stationId: row.iow_station_id,
        timestamp: point.t,
        station: iotStationFromPoint(row, new Date(point.t * 1000).toISOString(), point.v),
      });
    }
  }
  ordered.sort((a, b) => a.timestamp - b.timestamp);
  const latest = new Map<string, ChiayiWaterStation>();
  let cursor = 0;
  return frameTimes.map((frameTime) => {
    while (cursor < ordered.length && ordered[cursor]!.timestamp <= frameTime) {
      const item = ordered[cursor]!;
      latest.set(item.stationId, item.station);
      cursor += 1;
    }
    return [...latest.values()];
  });
}

function buildWaterFramesForDay(
  day: WaterDayRows,
  boundary: GeoJSON.FeatureCollection,
): ChiayiWaterFrame[] {
  const frameTimes = Array.from({ length: 24 }, (_, hour) => taiwanDateStartTimestamp(day.date) + hour * 3600);
  const rainFrames = buildStationFrames(
    day.rainGauge,
    boundary,
    frameTimes,
    (row) => row.observed_at,
    (row) => row.station_id,
    (row) => [row.lat, row.lng],
    rainStationFromRow,
  );
  const riverFrames = buildStationFrames(
    day.riverLevel,
    boundary,
    frameTimes,
    (row) => row.observed_at,
    (row) => row.station_id,
    (row) => [row.lat, row.lng],
    riverStationFromRow,
  );
  const iotFrames = buildIotStationFrames(day.iotRiver, boundary, frameTimes);
  return frameTimes.map((timestamp, index) => ({
    timestamp,
    date: day.date,
    rainGauge: rainFrames[index] ?? [],
    riverLevel: riverFrames[index] ?? [],
    iotRiver: iotFrames[index] ?? [],
  }));
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await worker(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, () => run()));
  return result;
}

export async function fetchChiayiWaterWeekData(
  boundary: GeoJSON.FeatureCollection,
  endDate = taiwanDateKey(),
): Promise<ChiayiWaterWeekData> {
  requireSupabase("水與雨一週資料");
  const window = buildChiayiWeekWindow(endDate);
  const dates = rollingTaiwanDates(endDate);
  const days = await mapWithConcurrency(dates, 2, (date) => readWaterDayRows(date));
  const frames = days.flatMap((day) => buildWaterFramesForDay(day, boundary));
  const availableDates = days
    .filter((day) => frames.some((frame) => frame.date === day.date && (frame.rainGauge.length + frame.riverLevel.length + frame.iotRiver.length > 0)))
    .map((day) => day.date);
  const missingDates = dates.filter((date) => !availableDates.includes(date));
  const partialErrors = days.flatMap((day) => day.partialErrors);
  if (availableDates.length === 0) {
    throw new ChiayiTopicLoaderError("network", partialErrors.join("；") || "近七日沒有正式嘉義市界內水與雨資料");
  }
  return {
    ...window,
    provider: "Pulse Supabase read RPC",
    dataEvidenceMode: "live",
    timeMode: "replay",
    fetchedAt: new Date().toISOString(),
    frames,
    availableDates,
    missingDates,
    partialErrors,
  };
}

export function waterFrameAtTime(
  data: ChiayiWaterWeekData | null,
  timestamp: number,
): ChiayiWaterFrame | null {
  if (!data) return null;
  const frameTimestamp = Math.floor(timestamp / 3600) * 3600;
  return data.frames.find((frame) => frame.timestamp === frameTimestamp) ?? null;
}

function routeFeatures(
  routes: Map<string, BusRouteGeometry>,
  boundary: GeoJSON.FeatureCollection,
): ChiayiBusRouteFeature[] {
  return [...routes.values()]
    .filter((route) => route.coords.length >= 2)
    .filter((route) => route.coords.some(([longitude, latitude]) => withinBoundary(boundary, latitude, longitude)))
    .map((route) => ({
      routeUid: route.routeUid,
      routeName: route.routeName,
      direction: route.direction,
      coordinates: route.coords,
    }));
}

function busPointsFromCurrent(
  buses: Awaited<ReturnType<typeof fetchBusCurrent>>,
  boundary: GeoJSON.FeatureCollection,
): ChiayiBusPoint[] {
  return buses
    .filter((bus) => withinBoundary(boundary, bus.lat, bus.lng))
    .map((bus) => ({
      id: `${bus.plateNumb}-${bus.routeUid ?? "unknown"}-${bus.direction}`,
      plateNumber: bus.plateNumb,
      routeUid: bus.routeUid ?? null,
      routeName: bus.routeName ?? null,
      direction: bus.direction,
      latitude: bus.lat,
      longitude: bus.lng,
      speedKmh: Number.isFinite(bus.speed) ? bus.speed : 0,
      observedAt: new Date(bus.collectedAt * 1000).toISOString(),
    }));
}

export async function fetchChiayiPublicTransportData(
  boundary: GeoJSON.FeatureCollection,
): Promise<ChiayiPublicTransportData> {
  requireSupabase("公共運輸資料");
  const partialErrors: string[] = [];
  const [routeData, busResult] = await Promise.all([
    loadBusRoutesForCity("Chiayi" as BusCity),
    fetchBusCurrent(["Chiayi"]),
  ]);
  const routes = routeFeatures(routeData.routes, boundary);
  const buses = busPointsFromCurrent(busResult, boundary);
  if (routes.length === 0) partialErrors.push("嘉義市路線資產沒有可畫的路段");
  if (buses.length === 0) partialErrors.push("目前沒有落在正式嘉義市界內的公車位置");
  return {
    provider: "Pulse route asset + Supabase read RPC",
    dataEvidenceMode: "live",
    timeMode: "live",
    fetchedAt: new Date().toISOString(),
    latestObservedAt: latestObservedAt(buses.map((bus) => bus.observedAt)),
    routes,
    buses,
    partialErrors,
  };
}

function normalizeBusTrail(
  trail: BusTrail,
  date: string,
  index: number,
): ChiayiBusReplayTrail | null {
  const path = trail.path
    .filter((point) => point.length >= 4 && point.every(Number.isFinite))
    .sort((a, b) => a[3] - b[3]);
  if (path.length === 0) return null;
  return {
    id: `${date}-${trail.plateNumb}-${trail.routeUid ?? "unknown"}-${trail.direction}-${index}`,
    plateNumber: trail.plateNumb,
    routeUid: trail.routeUid,
    routeName: trail.routeName,
    direction: trail.direction,
    path,
  };
}

export async function fetchChiayiPublicTransportWeekData(
  boundary: GeoJSON.FeatureCollection,
  endDate = taiwanDateKey(),
): Promise<ChiayiPublicTransportWeekData> {
  requireSupabase("公共運輸一週資料");
  const window = buildChiayiWeekWindow(endDate);
  const dates = rollingTaiwanDates(endDate);
  const [currentResult, datesResult] = await Promise.allSettled([
    fetchChiayiPublicTransportData(boundary),
    fetchBusDates(),
  ]);
  const partialErrors: string[] = [];
  const current = currentResult.status === "fulfilled" ? currentResult.value : null;
  if (currentResult.status === "rejected") {
    partialErrors.push(`目前公車：${currentResult.reason instanceof Error ? currentResult.reason.message : "服務回應失敗"}`);
  } else if (current?.partialErrors.length) {
    partialErrors.push(...current.partialErrors);
  }

  const availableIndexDates = datesResult.status === "fulfilled"
    ? new Set(datesResult.value.map((item) => item.day))
    : new Set<string>();
  if (datesResult.status === "rejected") {
    partialErrors.push(`公車歷史日期：${datesResult.reason instanceof Error ? datesResult.reason.message : "服務回應失敗"}`);
  }
  const historyDates = dates.filter((date) => availableIndexDates.has(date));
  const trailResults = await mapWithConcurrency(historyDates, 2, async (date) => ({
    date,
    trails: await fetchBusTrails(date, ["Chiayi" as BusCity]),
  }));
  const trails = trailResults.flatMap(({ date, trails: dayTrails }) => dayTrails
    .map((trail, index) => normalizeBusTrail(trail, date, index))
    .filter((trail): trail is ChiayiBusReplayTrail => trail !== null));
  const trailDates = new Set(trailResults.filter((item) => item.trails.length > 0).map((item) => item.date));
  const currentDate = taiwanDateKey(new Date());
  if (current?.buses.length && dates.includes(currentDate)) trailDates.add(currentDate);
  const availableDates = dates.filter((date) => trailDates.has(date));
  const missingDates = dates.filter((date) => !trailDates.has(date));
  if (missingDates.length > 0) {
    partialErrors.push(`公車歷史資料目前只涵蓋 ${availableDates.length}/${dates.length} 個日期；缺少日期不補軌跡`);
  }
  if (routesAreEmpty(current?.routes) && trails.length === 0 && !current?.buses.length) {
    throw new ChiayiTopicLoaderError("network", partialErrors.join("；") || "近七日沒有嘉義市公車資料");
  }
  return {
    ...window,
    provider: "Pulse route asset + Supabase read RPC",
    dataEvidenceMode: "live",
    timeMode: "replay",
    fetchedAt: new Date().toISOString(),
    routes: current?.routes ?? [],
    trails,
    liveSnapshot: current?.buses ?? [],
    availableDates,
    missingDates,
    partialErrors,
  };
}

function routesAreEmpty(routes: readonly ChiayiBusRouteFeature[] | undefined): boolean {
  return !routes || routes.length === 0;
}

function latestBusSnapshotTimestamp(buses: readonly ChiayiBusPoint[]): number {
  return buses.reduce((latest, bus) => Math.max(latest, Date.parse(bus.observedAt) / 1000), 0);
}

export function busPositionsAtTime(
  data: ChiayiPublicTransportWeekData | null,
  timestamp: number,
  boundary: GeoJSON.FeatureCollection,
): ChiayiBusPoint[] {
  if (!data) return [];
  const latestLiveTimestamp = latestBusSnapshotTimestamp(data.liveSnapshot);
  if (data.liveSnapshot.length > 0 && taiwanDateKey(new Date(timestamp * 1000)) === taiwanDateKey() && timestamp >= latestLiveTimestamp - 600) {
    return data.liveSnapshot;
  }
  const positions: ChiayiBusPoint[] = [];
  for (const trail of data.trails) {
    const first = trail.path[0];
    const last = trail.path[trail.path.length - 1];
    if (!first || !last || timestamp < first[3] || timestamp > last[3]) continue;
    const position = interpolatePosition(trail.path, timestamp);
    if (!position) continue;
    const [latitude, longitude] = position;
    if (!withinBoundary(boundary, latitude, longitude)) continue;
    positions.push({
      id: trail.id,
      plateNumber: trail.plateNumber,
      routeUid: trail.routeUid,
      routeName: trail.routeName,
      direction: trail.direction,
      latitude,
      longitude,
      speedKmh: 0,
      observedAt: new Date(timestamp * 1000).toISOString(),
    });
  }
  return positions;
}

function collectGeometryPositions(value: unknown, output: Array<[number, number]>): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    output.push([value[0], value[1]]);
    return;
  }
  value.forEach((child) => collectGeometryPositions(child, output));
}

function collectGeometryPositionsFromGeometry(
  geometry: GeoJSON.Geometry,
  output: Array<[number, number]>,
): void {
  if (geometry.type === "GeometryCollection") {
    geometry.geometries.forEach((child) => collectGeometryPositionsFromGeometry(child, output));
    return;
  }
  collectGeometryPositions(geometry.coordinates, output);
}

function geometryTouchesBoundary(
  geometry: GeoJSON.Geometry | null,
  boundary: GeoJSON.FeatureCollection,
): boolean {
  if (!geometry) return false;
  const positions: Array<[number, number]> = [];
  collectGeometryPositionsFromGeometry(geometry, positions);
  return positions.some(([longitude, latitude]) => withinBoundary(boundary, latitude, longitude));
}

function trafficEvents(
  events: readonly RoadEvent[],
  boundary: GeoJSON.FeatureCollection,
): ChiayiTrafficEvent[] {
  return events
    .filter((event) => geometryTouchesBoundary(event.geometry, boundary))
    .map((event) => ({
      id: event.event_id,
      source: event.source,
      title: event.title ?? "道路事件",
      roadName: event.road_name,
      eventType: event.event_type,
      severity: event.severity,
      startTs: event.start_ts,
      endTs: event.end_ts,
      geometry: event.geometry!,
    }));
}

export async function fetchChiayiTrafficData(
  boundary: GeoJSON.FeatureCollection,
  date = taiwanDateKey(),
): Promise<ChiayiTrafficData> {
  requireSupabase("交通流動資料");
  const [congestionResult, eventResult] = await Promise.allSettled([
    fetchRoadCongestionDay(date),
    fetchRoadEventsDay(date),
  ]);
  const partialErrors: string[] = [];
  const congestion = congestionResult.status === "fulfilled" ? congestionResult.value : null;
  const events = eventResult.status === "fulfilled" ? trafficEvents(eventResult.value, boundary) : [];
  if (congestionResult.status === "rejected") {
    partialErrors.push(`道路壅塞：${congestionResult.reason instanceof Error ? congestionResult.reason.message : "服務回應失敗"}`);
  }
  if (eventResult.status === "rejected") {
    partialErrors.push(`道路事件：${eventResult.reason instanceof Error ? eventResult.reason.message : "服務回應失敗"}`);
  }
  if (!congestion && events.length === 0) {
    throw new ChiayiTopicLoaderError("network", partialErrors.join("；") || "交通服務沒有回應");
  }
  return {
    provider: "Pulse Supabase read RPC + deployed Pulse PMTiles geometry",
    dataEvidenceMode: "live",
    timeMode: "replay",
    date,
    fetchedAt: new Date().toISOString(),
    congestion,
    events,
    partialErrors,
  };
}

export async function fetchChiayiTrafficWeekData(
  boundary: GeoJSON.FeatureCollection,
  endDate = taiwanDateKey(),
): Promise<ChiayiTrafficWeekData> {
  requireSupabase("交通一週資料");
  const window = buildChiayiWeekWindow(endDate);
  const dates = rollingTaiwanDates(endDate);
  const results = await mapWithConcurrency(dates, 2, async (date) => {
    try {
      return { date, data: await fetchChiayiTrafficData(boundary, date), error: null as string | null };
    } catch (error) {
      return {
        date,
        data: null,
        error: `${date}：${error instanceof Error ? error.message : "服務回應失敗"}`,
      };
    }
  });
  const days = results
    .map((result) => result.data)
    .filter((data): data is ChiayiTrafficData => data !== null);
  const availableDates = days
    .filter((data) => data.congestion !== null || data.events.length > 0)
    .map((data) => data.date);
  const missingDates = dates.filter((date) => !availableDates.includes(date));
  const partialErrors = [
    ...results.flatMap((result) => result.error ? [result.error] : []),
    ...days.flatMap((data) => data.partialErrors),
  ];
  if (days.length === 0) {
    throw new ChiayiTopicLoaderError("network", partialErrors.join("；") || "近七日沒有交通資料");
  }
  if (missingDates.length > 0) {
    partialErrors.push(`交通資料缺少 ${missingDates.length} 個日期；缺日不補道路狀態`);
  }
  return {
    ...window,
    provider: "Pulse Supabase read RPC + deployed Pulse PMTiles geometry",
    dataEvidenceMode: "live",
    timeMode: "replay",
    fetchedAt: new Date().toISOString(),
    days,
    availableDates,
    missingDates,
    partialErrors,
  };
}

export function trafficSlotTimestamp(date: string, slot: number): number {
  const safeSlot = Math.max(0, Math.min(287, Math.floor(slot)));
  return Date.parse(`${date}T00:00:00+08:00`) / 1000 + safeSlot * 300;
}

export function trafficSlotAtTimestamp(timestamp: number): number {
  const date = taiwanDateKey(new Date(timestamp * 1000));
  return Math.max(0, Math.min(287, Math.floor((timestamp - trafficSlotTimestamp(date, 0)) / 300)));
}

export function trafficDayAtTime(
  data: ChiayiTrafficWeekData | null,
  timestamp: number,
): ChiayiTrafficData | null {
  if (!data) return null;
  const date = taiwanDateKey(new Date(timestamp * 1000));
  return data.days.find((day) => day.date === date) ?? null;
}

export function latestTrafficSlot(data: ChiayiTrafficData | null): number {
  return data?.congestion?.lastPopulatedSlot ?? 0;
}
