import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWeatherQueryPoints,
  isCoordinateInsideBoundary,
  type WeatherQueryPoint,
} from "./chiayiBoundary";
import {
  buildWeatherForecastUrl,
  fetchChiayiWeatherForecast,
  resolveWeatherDisplayState,
  type FetchWeatherForecastOptions,
  type WeatherForecastData,
} from "./weatherForecast";

const boundary: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { area_code: "10020", area_name: "嘉義市" },
    geometry: {
      type: "Polygon",
      coordinates: [[[120.40, 23.44], [120.50, 23.44], [120.50, 23.52], [120.40, 23.52], [120.40, 23.44]]],
    },
  }],
};

const points: WeatherQueryPoint[] = [
  { id: "chiayi-grid-1", label: "模型點 1", latitude: 23.47, longitude: 120.43 },
  { id: "chiayi-grid-2", label: "模型點 2", latitude: 23.49, longitude: 120.47 },
];

function payload(latitude: number, longitude: number) {
  const times = ["2026-09-10T09:00", "2026-09-10T10:00", "2026-09-10T11:00"];
  return {
    latitude,
    longitude,
    timezone: "Asia/Taipei",
    current: {
      time: times[0],
      temperature_2m: 28.2,
      precipitation: 0.3,
      rain: 0.1,
      cloud_cover: 62,
      wind_speed_10m: 8.4,
    },
    hourly: {
      time: times,
      temperature_2m: [28.2, 28.5, 28.8],
      precipitation: [0.3, 0.5, null],
      rain: [0.1, 0.2, null],
      cloud_cover: [62, 67, 71],
      wind_speed_10m: [8.4, 8.8, 9.1],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("嘉義市 boundary sampling", () => {
  it("只在正式多邊形內產生最多九個模型查詢點", () => {
    const sampled = buildWeatherQueryPoints(boundary);
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.length).toBeLessThanOrEqual(9);
    expect(sampled.every((point) => isCoordinateInsideBoundary(boundary, point.latitude, point.longitude))).toBe(true);
  });
});

describe("Open-Meteo weather loader", () => {
  const readyWeather: WeatherForecastData = {
    provider: "Open-Meteo",
    sourceUrl: "https://api.open-meteo.com/v1/forecast",
    modelName: "jma_seamless",
    dataEvidenceMode: "live",
    timeMode: "live",
    dataRole: "model_forecast",
    fetchedAt: "2026-09-10T00:00:00.000Z",
    timezone: "Asia/Taipei",
    requestedPointCount: 1,
    deduplicatedSourceGridCount: 0,
    points: [],
  };

  it("建立 live forecast URL，且不加入 past_days 或歷史 replay 參數", () => {
    const url = new URL(buildWeatherForecastUrl(points));
    expect(url.searchParams.get("forecast_days")).toBe("2");
    expect(url.searchParams.get("timezone")).toBe("Asia/Taipei");
    expect(url.searchParams.get("past_days")).toBeNull();
    expect(url.searchParams.get("current")).toContain("cloud_cover");
    expect(url.searchParams.get("hourly")).toContain("rain");
  });

  it("正規化逐時資料、保留缺值，並合併相同來源格網中心", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([payload(23.48, 120.45), payload(23.48, 120.45)]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const options: FetchWeatherForecastOptions = { points, boundary };
    const result = await fetchChiayiWeatherForecast(options);
    expect(result.dataEvidenceMode).toBe("live");
    expect(result.timeMode).toBe("live");
    expect(result.dataRole).toBe("model_forecast");
    expect(result.requestedPointCount).toBe(2);
    expect(result.points).toHaveLength(1);
    expect(result.deduplicatedSourceGridCount).toBe(1);
    expect(result.points[0]?.hourly[2]?.precipitationMm).toBeNull();
    expect(result.points[0]?.hourly[0]?.validAt).toBe("2026-09-10T09:00");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("缺少逐時時間欄位時回報 schema error，不以空資料偽裝成功", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...payload(23.48, 120.45),
      hourly: { temperature_2m: [28] },
    }), { status: 200 })));
    await expect(fetchChiayiWeatherForecast({ points: [points[0]!] })).rejects.toMatchObject({ code: "schema" });
  });

  it("以 HTTP 429 明確回報服務錯誤，供 rate-limit 降級訊息使用", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(fetchChiayiWeatherForecast({ points: [points[0]!] })).rejects.toMatchObject({ code: "http" });
  });

  it("抓取時間超過一小時時移除 ready 狀態並標為 stale", () => {
    const now = Date.parse("2026-09-10T01:00:01.000Z");
    expect(resolveWeatherDisplayState(readyWeather, false, now)).toBe("stale");
    expect(resolveWeatherDisplayState(readyWeather, true, now)).toBe("error");
  });

  it("逾時時取消請求並回報 timeout", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    await expect(fetchChiayiWeatherForecast({ points: [points[0]!], timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
  });
});
