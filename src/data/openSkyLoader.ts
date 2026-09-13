/**
 * 免費航班來源：OpenSky Network（匿名可用，非商用免費）。
 *
 * 取代付費 FlightRadar24 作為航班資料源。OpenSky 給的是「即時狀態向量」（單點，
 * 含經緯度／航向／速度），沒有歷史軌跡；本模組用 heading+velocity 往回外推一小段，
 * 合成一條 2 點短軌跡，讓既有 FlightScene（trail 動畫）能直接渲染。
 *
 * CORS：OpenSky 只允許自家 origin，故 dev 走 vite.config 的 /opensky-proxy 同源代理
 * （正式部署需自備等價的反向代理／edge function）。
 */
import type { Flight, TrailPoint } from "../types";
import type { AirspaceData, AirspaceDateInfo } from "./airspaceLoader";
import { withLoading } from "../lib/loadingRegistry";

// 台灣（含外島鄰近空域）bounding box
const TAIWAN_BBOX = { lamin: 21.5, lomin: 119.0, lamax: 25.5, lomax: 122.5 };
/** 合成軌跡回推秒數（讓飛機有一小段可見、可動的路徑）。 */
const TRAIL_WINDOW_S = 300;
const METERS_PER_DEG_LAT = 111_320;

/** OpenSky /states/all 的 state vector 欄位索引（見官方文件）。 */
type OpenSkyState = [
  string,            // 0 icao24
  string | null,     // 1 callsign
  string,            // 2 origin_country
  number | null,     // 3 time_position
  number,            // 4 last_contact
  number | null,     // 5 longitude
  number | null,     // 6 latitude
  number | null,     // 7 baro_altitude (m)
  boolean,           // 8 on_ground
  number | null,     // 9 velocity (m/s)
  number | null,     // 10 true_track (deg, 0=N 順時針)
  ...unknown[]
];

interface OpenSkyResponse {
  time: number;
  states: OpenSkyState[] | null;
}

function buildFlight(s: OpenSkyState, nowSec: number): Flight | null {
  const icao = s[0];
  const callsign = (s[1] ?? "").trim();
  const lng = s[5];
  const lat = s[6];
  const onGround = s[8];
  const velocity = s[9] ?? 0;    // m/s
  const track = s[10] ?? 0;      // deg
  const alt = s[7] ?? 0;         // m
  if (lng == null || lat == null || onGround) return null; // 只收空中、且有座標者

  // 往回外推 TRAIL_WINDOW_S 秒，得到「過去」點；當下點為現在。
  const d = velocity * TRAIL_WINDOW_S; // 移動距離（公尺）
  const trackRad = (track * Math.PI) / 180;
  const dNorth = d * Math.cos(trackRad); // 前進方向的南北位移（公尺）
  const dEast = d * Math.sin(trackRad);
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const pastLat = lat - dNorth / METERS_PER_DEG_LAT;
  const pastLng = lng - dEast / (METERS_PER_DEG_LAT * cosLat);

  const past: TrailPoint = [pastLat, pastLng, alt, nowSec - TRAIL_WINDOW_S];
  const cur: TrailPoint = [lat, lng, alt, nowSec];

  return {
    fr24_id: icao,
    callsign: callsign || icao,
    registration: "",
    aircraft_type: "",
    origin_icao: "",
    origin_iata: "",
    dest_icao: "",
    dest_iata: "",
    dep_time: nowSec - TRAIL_WINDOW_S,
    arr_time: nowSec,
    status: "live",
    trail_points: 2,
    path: [past, cur],
  };
}

async function fetchOpenSky(): Promise<AirspaceData> {
  const { lamin, lomin, lamax, lomax } = TAIWAN_BBOX;
  const url = `/opensky-proxy/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const json = (await res.json()) as OpenSkyResponse;
  const nowSec = json.time ?? Math.floor(Date.now() / 1000);
  const flights: Flight[] = [];
  for (const s of json.states ?? []) {
    const f = buildFlight(s, nowSec);
    if (f) flights.push(f);
  }
  return {
    metadata: {
      date: new Date(nowSec * 1000).toISOString().slice(0, 10),
      aircraft_count: flights.length,
      time_range: [nowSec - TRAIL_WINDOW_S, nowSec],
    },
    flights,
  };
}

/** 供 airspaceLoader 分流：OpenSky 只有「當下」一個時段。 */
export async function fetchOpenSkyDates(): Promise<AirspaceDateInfo[]> {
  const today = new Date().toISOString().slice(0, 10);
  // records 需 > 100 才會被 loadAirspaceWithDates 選中；OpenSky 即時通常數百架，給個代表值。
  return [{ date: today, records: 999, flights: 999 }];
}

export async function loadOpenSkyAirspace(): Promise<AirspaceData> {
  return withLoading("airspace:opensky", "航班（OpenSky 即時）", fetchOpenSky());
}
