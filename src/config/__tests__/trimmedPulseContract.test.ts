/**
 * 精簡版白名單「閹割」契約測試（主 session 獨立驗證，P25-B）。
 *
 * 這是產品層契約的獨立證明：白名單內容符合定案，且非白名單層在
 * layerVisibilityStore 的每一條寫入路徑（setVisibility/toggle/setBulk/setAll）
 * 都無法被設為 true —— 亦即 URL / bulk / 場景還原任何入口都繞不過。
 * 不 render 地圖。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  trimmedPulseLayerAllowlist,
  isTrimmedPulseLayer,
  getTrimmedPulseCoverage,
  trimmedPulseUi,
} from "../trimmedPulseConfig";
import {
  layerVisibilityStore,
  buildDefaultVisibility,
} from "../../state/layerVisibilityStore";

type VisKey = keyof ReturnType<typeof buildDefaultVisibility>;

const allKeys = Object.keys(buildDefaultVisibility()) as VisKey[];
const allowKeys = allKeys.filter((k) => trimmedPulseLayerAllowlist.has(k));
const nonAllowKeys = allKeys.filter((k) => !trimmedPulseLayerAllowlist.has(k));

it("計數（供報告）", () => {
  // eslint-disable-next-line no-console
  console.log(`[TRIM-COUNT] TOTAL=${allKeys.length} ALLOW=${allowKeys.length} BLOCKED=${nonAllowKeys.length}`);
  expect(allKeys.length).toBeGreaterThan(0);
});

describe("B-1 白名單內容符合定案", () => {
  it("允許數＝42", () => expect(trimmedPulseLayerAllowlist.size).toBe(42));
  it("公車兩層在、touristShuttleLive 不在", () => {
    expect(isTrimmedPulseLayer("busLive")).toBe(true);
    expect(isTrimmedPulseLayer("busIntercityLive")).toBe(true);
    expect(isTrimmedPulseLayer("touristShuttleLive")).toBe(false);
  });
  it("25 層水資源全在（含 2 marine）", () => {
    const water = ["waterFacilities","waterMonitorStations","waterReservoirs","marineObservationCwa","marineObservationIsohe","groundwaterWells","rainGauge","riverLevel","floodSensor","iotWraRiver","iotWraStructure","taipeiSewer","taipeiEvacuate","taipeiPumb","waterBasins","waterRivers","waterLevees","waterCanals","waterProtectionZones","waterDetentionBasins","groundwater","lakesPondsOsm","waterFloodExtreme","floodSensorIsochrone","precipRaster"];
    for (const k of water) expect(isTrimmedPulseLayer(k)).toBe(true);
    expect(water.length).toBe(25);
  });
  it("4 層結構性非嘉義有 unsupported 原因", () => {
    for (const k of ["taipeiSewer","taipeiEvacuate","taipeiPumb","floodSensorIsochrone"] as VisKey[]) {
      const cov = getTrimmedPulseCoverage(k);
      expect(cov).toBeTruthy();
      expect(cov!.reason.length).toBeGreaterThan(0);
    }
  });
  it("範圍外面板 UI 全部關閉", () => {
    for (const v of Object.values(trimmedPulseUi)) expect(v).toBe(false);
  });
});

describe("B-2 全 key 空間：白名單可開、其餘一律被壓 false", () => {
  beforeEach(() => layerVisibilityStore.reset());

  it("setVisibility：allowlist 全可開", () => {
    for (const k of allowKeys) {
      layerVisibilityStore.setVisibility(k, true);
      expect(layerVisibilityStore.getVisibility(k)).toBe(true);
    }
  });
  it("setVisibility：非 allowlist 全被擋", () => {
    for (const k of nonAllowKeys) {
      layerVisibilityStore.setVisibility(k, true);
      expect(layerVisibilityStore.getVisibility(k)).toBe(false);
    }
  });
  it("toggle：非 allowlist 反轉開不起來", () => {
    for (const k of nonAllowKeys) {
      layerVisibilityStore.toggle(k);
      expect(layerVisibilityStore.getVisibility(k)).toBe(false);
    }
  });
  it("setBulk（模擬 URL/bulk 繞道）：只有 allowlist 生效", () => {
    layerVisibilityStore.setBulk(Object.fromEntries(allKeys.map((k) => [k, true])) as never);
    for (const k of allKeys) expect(layerVisibilityStore.getVisibility(k)).toBe(trimmedPulseLayerAllowlist.has(k));
  });
  it("setAll（模擬場景還原全開）：只有 allowlist 生效", () => {
    layerVisibilityStore.setAll(Object.fromEntries(allKeys.map((k) => [k, true])) as unknown as ReturnType<typeof buildDefaultVisibility>);
    for (const k of allKeys) expect(layerVisibilityStore.getVisibility(k)).toBe(trimmedPulseLayerAllowlist.has(k));
  });
});
