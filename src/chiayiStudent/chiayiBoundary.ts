import { withLoading } from "../lib/loadingRegistry";

export const CHIAYI_BOUNDARY_URL = "/statistics/county-reference-2025.geojson";
export const CHIAYI_BOUNDARY_VERSION = "county-reference-2025";
export const CHIAYI_CITY_CODE = "10020";

export interface WeatherQueryPoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

export class BoundaryLoaderError extends Error {
  readonly code: "network" | "http" | "schema" | "aborted";

  constructor(code: BoundaryLoaderError["code"], message: string) {
    super(message);
    this.name = "BoundaryLoaderError";
    this.code = code;
  }
}

function asFeatureCollection(value: unknown): GeoJSON.FeatureCollection {
  if (typeof value !== "object" || value === null) {
    throw new BoundaryLoaderError("schema", "嘉義市界線回應不是 GeoJSON 物件");
  }

  const candidate = value as { type?: unknown; features?: unknown };
  if (candidate.type !== "FeatureCollection" || !Array.isArray(candidate.features)) {
    throw new BoundaryLoaderError("schema", "嘉義市界線缺少 FeatureCollection");
  }

  const features = candidate.features.filter((feature): feature is GeoJSON.Feature => {
    if (typeof feature !== "object" || feature === null) return false;
    const item = feature as { type?: unknown; geometry?: unknown };
    return item.type === "Feature" && typeof item.geometry === "object" && item.geometry !== null;
  });

  if (features.length === 0) {
    throw new BoundaryLoaderError("schema", "嘉義市界線沒有可用圖徵");
  }

  return { type: "FeatureCollection", features };
}

export async function fetchChiayiBoundary(signal?: AbortSignal): Promise<GeoJSON.FeatureCollection> {
  let response: Response;
  try {
    response = await withLoading(
      "chiayi-boundary:county-reference-2025",
      "載入嘉義市正式界線",
      fetch(CHIAYI_BOUNDARY_URL, { signal }),
    );
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new BoundaryLoaderError("aborted", "嘉義市界線請求已取消");
    }
    throw new BoundaryLoaderError("network", "嘉義市界線目前無法連線");
  }

  if (!response.ok) {
    throw new BoundaryLoaderError("http", `嘉義市界線回應失敗（HTTP ${response.status}）`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BoundaryLoaderError("schema", "嘉義市界線 JSON 無法解析");
  }

  const all = asFeatureCollection(body);
  const chiayi = all.features.find((feature) => {
    const properties = feature.properties ?? {};
    return properties.area_code === CHIAYI_CITY_CODE || properties.area_name === "嘉義市";
  });

  if (!chiayi) {
    throw new BoundaryLoaderError("schema", "固定界線檔找不到嘉義市圖徵");
  }

  return {
    type: "FeatureCollection",
    features: [chiayi],
  };
}

type Position = [number, number];

function readPosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = value[0];
  const latitude = value[1];
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

function collectPositions(value: unknown, output: Position[]): void {
  const position = readPosition(value);
  if (position) {
    output.push(position);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const child of value) collectPositions(child, output);
}

function pointInRing(point: Position, ring: Position[]): boolean {
  if (ring.length < 3) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i];
    const previous = ring[j];
    if (!current || !previous) continue;
    const [xi, yi] = current;
    const [xj, yj] = previous;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function ringFromUnknown(value: unknown): Position[] {
  if (!Array.isArray(value)) return [];
  return value.map(readPosition).filter((position): position is Position => position !== null);
}

function polygonContains(coordinates: unknown, point: Position): boolean {
  if (!Array.isArray(coordinates)) return false;
  const rings = coordinates as unknown[];
  const outer = ringFromUnknown(rings[0]);
  if (!pointInRing(point, outer)) return false;
  return !rings.slice(1).some((hole) => pointInRing(point, ringFromUnknown(hole)));
}

function geometryContains(geometry: unknown, point: Position): boolean {
  if (typeof geometry !== "object" || geometry === null) return false;
  const candidate = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (candidate.type === "Polygon") return polygonContains(candidate.coordinates, point);
  if (candidate.type === "MultiPolygon") {
    if (!Array.isArray(candidate.coordinates)) return false;
    return candidate.coordinates.some((polygon) => polygonContains(polygon, point));
  }
  if (candidate.type === "GeometryCollection" && Array.isArray(candidate.geometries)) {
    return candidate.geometries.some((item) => geometryContains(item, point));
  }
  return false;
}

export function isCoordinateInsideBoundary(
  boundary: GeoJSON.FeatureCollection,
  latitude: number,
  longitude: number,
): boolean {
  return boundary.features.some((feature) => geometryContains(feature.geometry, [longitude, latitude]));
}

export function buildWeatherQueryPoints(boundary: GeoJSON.FeatureCollection): WeatherQueryPoint[] {
  const positions: Position[] = [];
  for (const feature of boundary.features) {
    const geometry = feature.geometry;
    if (geometry && "coordinates" in geometry) collectPositions(geometry.coordinates, positions);
  }
  if (positions.length === 0) {
    throw new BoundaryLoaderError("schema", "嘉義市界線沒有可取樣的座標");
  }

  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);

  const candidates: Position[] = [];
  const gridSize = 5;
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const longitude = minLongitude + ((column + 0.5) / gridSize) * (maxLongitude - minLongitude);
      const latitude = minLatitude + ((row + 0.5) / gridSize) * (maxLatitude - minLatitude);
      if (isCoordinateInsideBoundary(boundary, latitude, longitude)) candidates.push([longitude, latitude]);
    }
  }

  const unique = [...new Map(candidates.map((position) => [position.map((value) => value.toFixed(6)).join(","), position])).values()];
  if (unique.length === 0) {
    throw new BoundaryLoaderError("schema", "嘉義市界線內沒有可用的天氣取樣點");
  }

  const limited = unique.length <= 9
    ? unique
    : unique.filter((_, index) => index % Math.ceil(unique.length / 9) === 0).slice(0, 9);

  return limited.map(([longitude, latitude], index) => ({
    id: `chiayi-grid-${index + 1}`,
    label: `模型點 ${index + 1}`,
    latitude,
    longitude,
  }));
}

export function getBoundaryPositions(boundary: GeoJSON.FeatureCollection): Position[] {
  const positions: Position[] = [];
  for (const feature of boundary.features) {
    const geometry = feature.geometry;
    if (geometry && "coordinates" in geometry) collectPositions(geometry.coordinates, positions);
  }
  return positions;
}
