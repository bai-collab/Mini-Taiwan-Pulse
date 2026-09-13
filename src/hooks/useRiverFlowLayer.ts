import { useEffect } from "react";
import type { Map as MaplibreMap } from "maplibre-gl";
import { useMapReadyTick } from "./useMapReadyTick";

/**
 * 河川水流方向動畫（教學用）。
 *
 * 在既有 `water-rivers` source（OSM waterway 線，沿下游方向數化）上疊一條發光虛線，
 * 每幀位移 dash pattern 造出「marching ants」流動效果 → 學生可觀察水往哪個方向流。
 * OSM waterway 慣例沿上游→下游數化，故動畫方向≈實際水流方向（個別線段可能反向，屬資料限制）。
 *
 * 設計對齊 useSubstationDiamondIcon：mapRef 是 ref 不觸發 re-render，故用 polling 等 map/source ready。
 * 只在 waterRivers 圖層可見時執行 rAF，隱藏或卸載即停止並移除圖層（不留背景動畫耗電）。
 */
const SOURCE_ID = "water-rivers";
const FLOW_LAYER_ID = "water-rivers-flow";

// MapLibre 官方 marching-ants dash 序列：逐幀切換造出單向流動（沿線幾何方向）。
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1],
  [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5],
  [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

export function useRiverFlowLayer(
  mapRef: React.RefObject<MaplibreMap | null>,
  visible: boolean,
  isDark: boolean,
) {
  // map 首載 load 可能晚達；mapRef.current 變動不觸發 re-render → 用 tick 讓 effect 重跑。
  const mapTick = useMapReadyTick(mapRef, visible);
  useEffect(() => {
    let stopped = false;
    let animId: number | null = null;
    let pollId: number | null = null;
    let step = 0;

    const flowColor = isDark ? "#7dd3fc" : "#0ea5e9";

    const removeFlow = (map: MaplibreMap) => {
      if (map.getLayer(FLOW_LAYER_ID)) map.removeLayer(FLOW_LAYER_ID);
    };

    const ensureLayer = (map: MaplibreMap): boolean => {
      if (!map.getSource(SOURCE_ID)) return false; // 河川 overlay 尚未 hydrate
      if (!map.getLayer(FLOW_LAYER_ID)) {
        map.addLayer({
          id: FLOW_LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": flowColor,
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 12, 2.2, 15, 3.5],
            "line-opacity": 0.9,
            "line-dasharray": DASH_SEQUENCE[0],
          },
        });
      }
      return true;
    };

    // 用 setInterval 而非 requestAnimationFrame 驅動 dash 位移：
    // rAF 在頁面未實際繪製（背景/隱藏 compositor）時會被餓死而暫停，
    // setInterval 較穩定；~90ms 一步的 marching-ants 對水流動畫已足夠順。
    const tickAnim = () => {
      if (stopped) return;
      const map = mapRef.current;
      if (!map || !map.getLayer(FLOW_LAYER_ID)) return;
      step = (step + 1) % DASH_SEQUENCE.length;
      try {
        map.setPaintProperty(FLOW_LAYER_ID, "line-dasharray", DASH_SEQUENCE[step]);
      } catch { /* style 切換瞬間可能失效，下一步自動恢復 */ }
    };

    const start = () => {
      const map = mapRef.current;
      if (stopped || !map) return false;
      // 不查 isStyleLoaded()：本 app 圖層多、tile 常態載入 → 它幾乎恆為 false，
      // 會永久擋住建層。加 line layer 到既有 geojson source 不需 style 全載，
      // 真正的前置條件是「source 已存在」，由 ensureLayer 把關。
      if (!ensureLayer(map)) return false; // source 未就緒 → 繼續 poll
      if (animId === null) animId = window.setInterval(tickAnim, 90);
      return true;
    };

    const stopAnim = () => {
      if (animId !== null) { window.clearInterval(animId); animId = null; }
    };

    if (visible) {
      if (!start()) {
        // 等 map / source ready（河川 overlay lazy hydrate 完成後才有 source）
        pollId = window.setInterval(() => {
          if (start() && pollId !== null) { window.clearInterval(pollId); pollId = null; }
        }, 150);
      }
    } else {
      const map = mapRef.current;
      if (map) removeFlow(map);
    }

    return () => {
      stopped = true;
      stopAnim();
      if (pollId !== null) window.clearInterval(pollId);
      const map = mapRef.current;
      if (map) removeFlow(map);
    };
  }, [mapRef, visible, isDark, mapTick]);
}
