/**
 * 逐層「資料狀態」store（AR-21 同款：模組級 state + 細粒度訂閱）。
 *
 * 用途：讓側欄徽章能對「已開啟卻沒東西」的層說清楚原因——
 *   loading（載入中）/ ready（有來源、正常）/ error（來源載入失敗，多為缺資產 404）。
 *
 * 只涵蓋 OVERLAY_REGISTRY 的靜態／PMTiles 層（由 MapView 的 source error/sourcedata 事件驅動）。
 * 交通等以 count 判斷的動態層走 sidebar count（不寫這裡）。
 */
import { useCallback, useSyncExternalStore } from "react";
import type { LayerVisibility } from "../types";

export type LayerDataStatus = "loading" | "ready" | "empty" | "error";
type VisKey = keyof LayerVisibility;
type Listener = () => void;

const statusByKey = new Map<VisKey, LayerDataStatus>();
const globalListeners = new Set<Listener>();
const keyListeners = new Map<VisKey, Set<Listener>>();

function notify(key: VisKey) {
  const set = keyListeners.get(key);
  if (set) for (const cb of set) cb();
  for (const cb of globalListeners) cb();
}

export const layerDataStatusStore = {
  get(key: VisKey): LayerDataStatus | undefined {
    return statusByKey.get(key);
  },
  set(key: VisKey, status: LayerDataStatus): void {
    if (statusByKey.get(key) === status) return;
    statusByKey.set(key, status);
    notify(key);
  },
  clear(key: VisKey): void {
    if (!statusByKey.has(key)) return;
    statusByKey.delete(key);
    notify(key);
  },
  subscribeKey(key: VisKey, cb: Listener): () => void {
    let set = keyListeners.get(key);
    if (!set) { set = new Set(); keyListeners.set(key, set); }
    const s = set;
    s.add(cb);
    return () => { s.delete(cb); if (s.size === 0) keyListeners.delete(key); };
  },
  subscribe(cb: Listener): () => void {
    globalListeners.add(cb);
    return () => globalListeners.delete(cb);
  },
};

export function useLayerDataStatus(key: VisKey): LayerDataStatus | undefined {
  const subscribe = useCallback(
    (cb: Listener) => layerDataStatusStore.subscribeKey(key, cb),
    [key],
  );
  return useSyncExternalStore(
    subscribe,
    () => layerDataStatusStore.get(key),
    () => layerDataStatusStore.get(key),
  );
}
