import { withLoading } from "../lib/loadingRegistry";
import { isCoordinateInsideBoundary, type WeatherQueryPoint } from "./chiayiBoundary";

export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_MODEL = "jma_seamless";
export const WEATHER_REQUEST_TIMEOUT_MS = 8_000;
export const WEATHER_STALE_AFTER_MS = 60 * 60 * 1000;
export const WEATHER_MAX_QUERY_POINTS = 9;

export interface WeatherHourlyValue {
  validAt: string;
  temperature2mC: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  cloudCoverPct: number | null;
  windSpeedKmh: number | null;
}

export interface WeatherPoint {
  pointId: string;
  label: string;
  sourceGridLatitude: number;
  sourceGridLongitude: number;
  timezone: "Asia/Taipei";
  current: WeatherHourlyValue;
  hourly: WeatherHourlyValue[];
  dataRole: "model_forecast";
}

export interface WeatherForecastData {
  provider: "Open-Meteo";
  sourceUrl: string;
  modelName: string;
  dataEvidenceMode: "live";
  timeMode: "live";
  dataRole: "model_forecast";
  fetchedAt: string;
  timezone: "Asia/Taipei";
  points: WeatherPoint[];
  requestedPointCount: number;
  deduplicatedSourceGridCount: number;
}

export type WeatherDisplayState = "loading" | "ready" | "stale" | "error";

export function resolveWeatherDisplayState(
  weather: WeatherForecastData | null,
  hasError: boolean,
  nowMs = Date.now(),
): WeatherDisplayState {
  if (hasError) return "error";
  if (!weather) return "loading";
  return nowMs - Date.parse(weather.fetchedAt) > WEATHER_STALE_AFTER_MS ? "stale" : "ready";
}

export type WeatherLoaderErrorCode = "network" | "timeout" | "http" | "schema" | "aborted";

export class WeatherLoaderError extends Error {
  readonly code: WeatherLoaderErrorCode;

  constructor(code: WeatherLoaderErrorCode, message: string) {
    super(message);
    this.name = "WeatherLoaderError";
    this.code = code;
  }
}

export interface FetchWeatherForecastOptions {
  points: readonly WeatherQueryPoint[];
  boundary?: GeoJSON.FeatureCollection;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const HOURLY_VARIABLES = ["temperature_2m", "precipitation", "rain", "cloud_cover", "wind_speed_10m"] as const;
const CURRENT_VARIABLES = ["temperature_2m", "precipitation", "rain", "cloud_cover", "wind_speed_10m"] as const;

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  return toFiniteNumber(value[index]);
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asPointPayloads(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(readObject);
  return [readObject(value)];
}

export function buildWeatherForecastUrl(points: readonly WeatherQueryPoint[]): string {
  if (points.length === 0) throw new WeatherLoaderError("schema", "沒有可用的嘉義市天氣取樣點");
  if (points.length > WEATHER_MAX_QUERY_POINTS) {
    throw new WeatherLoaderError("schema", `天氣取樣點超過 ${WEATHER_MAX_QUERY_POINTS} 點上限`);
  }

  const params = new URLSearchParams({
    latitude: points.map((point) => point.latitude.toFixed(6)).join(","),
    longitude: points.map((point) => point.longitude.toFixed(6)).join(","),
    current: CURRENT_VARIABLES.join(","),
    hourly: HOURLY_VARIABLES.join(","),
    forecast_days: "2",
    models: OPEN_METEO_MODEL,
    timezone: "Asia/Taipei",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
  });
  return `${OPEN_METEO_FORECAST_URL}?${params.toString()}`;
}

function normalizeHourly(
  hourly: Record<string, unknown>,
  index: number,
): WeatherHourlyValue {
  const times = hourly.time;
  return {
    validAt: typeof times === "string" ? times : Array.isArray(times) && typeof times[index] === "string" ? times[index] as string : "",
    temperature2mC: arrayValue(hourly.temperature_2m, index),
    precipitationMm: arrayValue(hourly.precipitation, index),
    rainMm: arrayValue(hourly.rain, index),
    cloudCoverPct: arrayValue(hourly.cloud_cover, index),
    windSpeedKmh: arrayValue(hourly.wind_speed_10m, index),
  };
}

function normalizePoint(
  payload: Record<string, unknown>,
  requestPoint: WeatherQueryPoint,
): WeatherPoint {
  const sourceGridLatitude = toFiniteNumber(payload.latitude);
  const sourceGridLongitude = toFiniteNumber(payload.longitude);
  const timezone = payload.timezone;
  const current = readObject(payload.current);
  const hourly = readObject(payload.hourly);
  const times = hourly.time;

  if (sourceGridLatitude === null || sourceGridLongitude === null) {
    throw new WeatherLoaderError("schema", "天氣回應缺少模型格網座標");
  }
  if (timezone !== "Asia/Taipei") {
    throw new WeatherLoaderError("schema", "天氣回應時區不是 Asia/Taipei");
  }
  if (!Array.isArray(times) || times.length === 0 || times.some((time) => typeof time !== "string")) {
    throw new WeatherLoaderError("schema", "天氣回應缺少逐時 validAt");
  }

  const normalizedHourly = times.map((_, index) => normalizeHourly(hourly, index));
  const currentTime = typeof current.time === "string" ? current.time : normalizedHourly[0]?.validAt ?? "";
  if (!currentTime) throw new WeatherLoaderError("schema", "天氣回應缺少目前有效時間");

  const currentValue: WeatherHourlyValue = {
    validAt: currentTime,
    temperature2mC: toFiniteNumber(current.temperature_2m),
    precipitationMm: toFiniteNumber(current.precipitation),
    rainMm: toFiniteNumber(current.rain),
    cloudCoverPct: toFiniteNumber(current.cloud_cover),
    windSpeedKmh: toFiniteNumber(current.wind_speed_10m),
  };

  return {
    pointId: requestPoint.id,
    label: requestPoint.label,
    sourceGridLatitude,
    sourceGridLongitude,
    timezone: "Asia/Taipei",
    current: currentValue,
    hourly: normalizedHourly,
    dataRole: "model_forecast",
  };
}

function createTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function explainFetchError(error: unknown, externalSignal: AbortSignal | undefined, timedOut: () => boolean): never {
  if (externalSignal?.aborted) throw new WeatherLoaderError("aborted", "嘉義市天氣請求已取消");
  if (timedOut() || (error instanceof DOMException && error.name === "AbortError")) {
    throw new WeatherLoaderError("timeout", "嘉義市天氣請求逾時");
  }
  throw new WeatherLoaderError("network", "嘉義市天氣目前無法連線");
}

export async function fetchChiayiWeatherForecast(options: FetchWeatherForecastOptions): Promise<WeatherForecastData> {
  const { points, boundary, signal, timeoutMs = WEATHER_REQUEST_TIMEOUT_MS } = options;
  const url = buildWeatherForecastUrl(points);
  const timeout = createTimeoutSignal(signal, timeoutMs);

  let response: Response;
  try {
    response = await withLoading(
      "chiayi-weather:live",
      "正在取得嘉義天氣模型資料",
      fetch(url, { signal: timeout.signal }),
    );
  } catch (error) {
    timeout.cleanup();
    return explainFetchError(error, signal, timeout.timedOut);
  }

  try {
    if (!response.ok) {
      throw new WeatherLoaderError("http", `天氣服務回應失敗（HTTP ${response.status}）`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WeatherLoaderError("schema", "天氣服務回應不是有效 JSON");
    }

    const payloads = asPointPayloads(body);
    if (payloads.length !== points.length) {
      throw new WeatherLoaderError("schema", "天氣回應點數與請求不一致");
    }

    const normalized = payloads.map((payload, index) => {
      const requestPoint = points[index];
      if (!requestPoint) throw new WeatherLoaderError("schema", "天氣回應缺少對應取樣點");
      return normalizePoint(payload, requestPoint);
    });

    const inside = boundary
      ? normalized.filter((point) => isCoordinateInsideBoundary(boundary, point.sourceGridLatitude, point.sourceGridLongitude))
      : normalized;
    if (inside.length === 0) {
      throw new WeatherLoaderError("schema", "模型格網中心不在嘉義市界內");
    }

    const uniqueByGrid = new Map<string, WeatherPoint>();
    for (const point of inside) {
      const key = `${point.sourceGridLatitude.toFixed(5)},${point.sourceGridLongitude.toFixed(5)}`;
      if (!uniqueByGrid.has(key)) uniqueByGrid.set(key, point);
    }

    return {
      provider: "Open-Meteo",
      sourceUrl: OPEN_METEO_FORECAST_URL,
      modelName: OPEN_METEO_MODEL,
      dataEvidenceMode: "live",
      timeMode: "live",
      dataRole: "model_forecast",
      fetchedAt: new Date().toISOString(),
      timezone: "Asia/Taipei",
      points: [...uniqueByGrid.values()],
      requestedPointCount: points.length,
      deduplicatedSourceGridCount: inside.length - uniqueByGrid.size,
    };
  } finally {
    timeout.cleanup();
  }
}
