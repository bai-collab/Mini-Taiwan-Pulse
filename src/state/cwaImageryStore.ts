import { useSyncExternalStore } from "react";

export type CwaImageryStatusKey = "cwaCloudImagery" | "cwaRadarImagery";
export type CwaImageryStatusState = "idle" | "loading" | "ready" | "no-data" | "error";

export interface CwaImageryStatus {
  state: CwaImageryStatusState;
  frameIso: string | null;
  error: string | null;
}

const EMPTY: CwaImageryStatus = { state: "idle", frameIso: null, error: null };
const state: Record<CwaImageryStatusKey, CwaImageryStatus> = {
  cwaCloudImagery: EMPTY,
  cwaRadarImagery: EMPTY,
};
const listeners = new Set<() => void>();

export const cwaImageryStore = {
  get(key: CwaImageryStatusKey): CwaImageryStatus {
    return state[key];
  },
  set(key: CwaImageryStatusKey, next: CwaImageryStatus): void {
    const current = state[key];
    if (
      current.state === next.state &&
      current.frameIso === next.frameIso &&
      current.error === next.error
    ) return;
    state[key] = next;
    for (const listener of listeners) listener();
  },
  clear(key: CwaImageryStatusKey): void {
    cwaImageryStore.set(key, EMPTY);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useCwaImageryStatus(key: CwaImageryStatusKey): CwaImageryStatus {
  return useSyncExternalStore(
    cwaImageryStore.subscribe,
    () => cwaImageryStore.get(key),
    () => EMPTY,
  );
}
