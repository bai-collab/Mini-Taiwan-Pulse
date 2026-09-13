// MapLibre 的 PMTiles 共用 protocol 註冊點。
// 每個 source 都是普通 vector/raster source，URL 使用 pmtiles://<absolute-url>。
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

let registered = false;

export function registerPmtilesProtocolOnce(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
}

/** 舊 factory 名稱的相容別名；實際上註冊的是 MapLibre protocol。 */
export const registerPmtilesSourceTypeOnce = registerPmtilesProtocolOnce;

/** 把 registry 的相對路徑轉成 PMTiles protocol 可讀的絕對 URL。 */
export function absolutePmtilesUrl(url: string): string {
  const base = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  return new URL(url, base).href;
}

export function pmtilesUrl(url: string): string {
  if (url.startsWith("pmtiles://")) return url;
  return `pmtiles://${absolutePmtilesUrl(url)}`;
}
