/**
 * 嘉義學生版公車 3D 圖層。
 *
 * 這支 adapter 不重新發明車輛動畫，而是把學生版的邊界／週資料格式
 * 接到既有 Pulse BusEngine + BusScene：
 *
 *   historical trail → route progress → LineString position → Three.js orb
 *
 * MapLibre 的矩陣差異由 createThreeReplayLayer 統一處理；因此這裡只負責
 * 把嘉義的路線與日期資料轉成主站引擎需要的 domain shape。
 */

import type { CustomLayerInterface } from "maplibre-gl";
import type {
  BusPosition,
  BusRouteData,
  BusRouteGeometry,
  BusTrail,
} from "../types";
import { BusEngine } from "../engines/BusEngine";
import { BusScene } from "../three/BusScene";
import { createThreeReplayLayer, type ReplayScene } from "../embed/threeReplayLayer";
import { isCoordinateInsideBoundary } from "./chiayiBoundary";
import {
  taiwanDateKey,
  type ChiayiBusPoint,
  type ChiayiBusReplayTrail,
  type ChiayiBusRouteFeature,
  type ChiayiPublicTransportWeekData,
} from "./liveTopics";

export const CHIAYI_BUS_3D_LAYER_ID = "chiayi-student-bus-3d";

export interface ChiayiBus3dController {
  layer: CustomLayerInterface;
  setData(data: ChiayiPublicTransportWeekData | null): void;
  setBoundary(boundary: GeoJSON.FeatureCollection | null): void;
  setTime(timestamp: number): void;
  setVisible(visible: boolean): void;
}

interface PreparedBusData {
  routes: BusRouteData;
  trailsByDay: Map<string, BusTrail[]>;
  liveSnapshot: BusPosition[];
  liveTimestamp: number;
}

function routeDistance(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function toRouteGeometry(route: ChiayiBusRouteFeature): BusRouteGeometry | null {
  const coords = route.coordinates.filter(
    (coordinate): coordinate is [number, number] =>
      Array.isArray(coordinate) && coordinate.length >= 2 &&
      Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]),
  );
  if (coords.length < 2) return null;

  const cumDist = [0];
  for (let index = 1; index < coords.length; index += 1) {
    cumDist.push(cumDist[index - 1]! + routeDistance(coords[index - 1]!, coords[index]!));
  }

  const totalDist = cumDist[cumDist.length - 1] ?? 0;
  if (totalDist <= 0) return null;

  return {
    routeUid: route.routeUid,
    routeName: route.routeName,
    direction: route.direction,
    coords,
    cumDist,
    totalDist,
    stopProgress: [],
    stopNames: [],
    subRouteName: route.routeName,
    // 嘉義學生版目前沒有班表頻率欄位；保留主站低密度預設色階。
    frequency: 0.5,
  };
}

function toRouteData(routes: readonly ChiayiBusRouteFeature[]): BusRouteData {
  const routeMap = new Map<string, BusRouteGeometry>();
  const routeIndex = new Map<string, string[]>();

  for (const route of routes) {
    const geometry = toRouteGeometry(route);
    if (!geometry || !route.routeUid) continue;
    const key = `${route.routeUid}_${route.direction}`;
    routeMap.set(key, geometry);
    const keys = routeIndex.get(route.routeUid) ?? [];
    if (!keys.includes(key)) keys.push(key);
    routeIndex.set(route.routeUid, keys);
  }

  return { routes: routeMap, routeIndex };
}

function trailDate(path: BusTrail["path"]): string | null {
  const timestamp = path[0]?.[3];
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return taiwanDateKey(new Date(timestamp * 1000));
}

function toBusTrail(trail: ChiayiBusReplayTrail): BusTrail | null {
  const path = trail.path
    .filter((point) => point.length >= 4 && point.every(Number.isFinite))
    .sort((a, b) => a[3] - b[3]);
  if (path.length < 2) return null;
  return {
    plateNumb: trail.plateNumber,
    routeUid: trail.routeUid,
    routeName: trail.routeName,
    direction: trail.direction,
    city: "Chiayi",
    path,
  };
}

function toBusPosition(bus: ChiayiBusPoint): BusPosition | null {
  if (!bus.routeUid) return null;
  const collectedAt = Date.parse(bus.observedAt) / 1000;
  if (!Number.isFinite(collectedAt)) return null;
  return {
    plateNumb: bus.plateNumber,
    routeUid: bus.routeUid,
    routeName: bus.routeName ?? "未知路線",
    direction: bus.direction,
    lat: bus.latitude,
    lng: bus.longitude,
    speed: Number.isFinite(bus.speedKmh) ? bus.speedKmh : 0,
    collectedAt,
    city: "Chiayi",
  };
}

function prepareBusData(data: ChiayiPublicTransportWeekData): PreparedBusData {
  const trailsByDay = new Map<string, BusTrail[]>();
  for (const sourceTrail of data.trails) {
    const trail = toBusTrail(sourceTrail);
    if (!trail) continue;
    const day = trailDate(trail.path);
    if (!day) continue;
    const dayTrails = trailsByDay.get(day) ?? [];
    dayTrails.push(trail);
    trailsByDay.set(day, dayTrails);
  }

  const liveSnapshot = data.liveSnapshot
    .map(toBusPosition)
    .filter((bus): bus is BusPosition => bus !== null);
  const liveTimestamp = liveSnapshot.reduce(
    (latest, bus) => Math.max(latest, bus.collectedAt),
    0,
  );

  return {
    routes: toRouteData(data.routes),
    trailsByDay,
    liveSnapshot,
    liveTimestamp,
  };
}

class ChiayiBus3dControllerImpl implements ChiayiBus3dController {
  private engine = new BusEngine();
  private readonly scene = new BusScene(1600);
  private prepared: PreparedBusData | null = null;
  private currentTimestamp = 0;
  private loadedDay = "";
  private visible = false;
  private boundary: GeoJSON.FeatureCollection | null = null;

  readonly layer: CustomLayerInterface;

  constructor() {
    const replayScene: ReplayScene = {
      init: (gl) => {
        this.scene.init(gl as WebGLRenderingContext);
        // 學生版使用明亮 OSM 底圖；暗色 additive 光球會被淺色地圖洗白，
        // 這裡改用亮底圖的 Normal blending，保留路線色與速度色階。
        this.scene.setTheme(false);
        // 嘉義學生版地圖預設約 zoom 11；比主站全台視角放大一級，
        // 讓 3D 車輛在路線密集區仍能被看見，但不遮住地圖。
        this.scene.setOrbScale(0.000012);
        this.scene.setAltitudeOffset(0);
      },
      update: (timestamp) => {
        if (!this.visible || !this.prepared || !Number.isFinite(timestamp) || timestamp <= 0) {
          this.scene.update([], "route");
          return;
        }

        this.ensureDay(timestamp);
        const vehicles = this.engine.update(timestamp).filter((vehicle) => {
          if (!this.boundary) return true;
          return isCoordinateInsideBoundary(this.boundary, vehicle.position[1], vehicle.position[0]);
        });
        this.scene.update(vehicles, "route");
      },
      render: (matrix) => {
        this.scene.render(matrix as unknown as number[]);
      },
      dispose: () => {
        this.engine.dispose();
        this.scene.dispose();
      },
    };

    this.layer = createThreeReplayLayer({
      id: CHIAYI_BUS_3D_LAYER_ID,
      scene: replayScene,
      getTime: () => this.currentTimestamp,
    });

  }

  setData(data: ChiayiPublicTransportWeekData | null): void {
    this.prepared = data ? prepareBusData(data) : null;
    this.loadedDay = "";
    this.resetEngine();
  }

  setBoundary(boundary: GeoJSON.FeatureCollection | null): void {
    this.boundary = boundary;
  }

  setTime(timestamp: number): void {
    this.currentTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  private resetEngine(): void {
    this.engine.dispose();
    this.engine = new BusEngine();
    if (this.prepared) this.engine.addCityRoutes("Chiayi", this.prepared.routes);
  }

  private ensureDay(timestamp: number): void {
    if (!this.prepared) return;
    const day = taiwanDateKey(new Date(timestamp * 1000));
    if (day === this.loadedDay) return;

    // BusEngine 內部同時保留 live 與 replay 狀態；換日期時重建，避免
    // 缺資料的日期沿用前一天的車輛。
    this.resetEngine();
    const trails = this.prepared.trailsByDay.get(day) ?? [];
    if (trails.length > 0) {
      this.engine.ingestTrails(trails);
    } else if (
      this.prepared.liveSnapshot.length > 0 &&
      this.prepared.liveTimestamp > 0 &&
      taiwanDateKey(new Date(this.prepared.liveTimestamp * 1000)) === day &&
      Math.abs(timestamp - this.prepared.liveTimestamp) <= 900
    ) {
      // 歷史日沒有 trail 時，只在最新快照的合理時間窗使用 live fallback。
      this.engine.ingestPoll(this.prepared.liveSnapshot, this.prepared.liveTimestamp);
    }
    this.loadedDay = day;
  }

}

export function createChiayiBus3dController(): ChiayiBus3dController {
  return new ChiayiBus3dControllerImpl();
}
