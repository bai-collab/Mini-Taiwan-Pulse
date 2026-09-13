import type { LayerVisibility } from "../../types";
import {
  getTrimmedPulseCoverage,
  getTrimmedPulseLayerModeLabel,
  type TrimmedPulseLayerKey,
} from "../../config/trimmedPulseConfig";
import { useLayerDataStatus } from "../../state/layerDataStatusStore";

/**
 * 逐層 meta + 狀態徽章。
 * 狀態優先序：不支援（coverage）> 載入中 > 無資料 > （有資料由 LayerRow 的數字顯示）。
 * 只有 `active`（已開啟）且非 locked 才顯示資料狀態；未開啟只顯示時間模式。
 */
export function TrimmedLayerMeta({
  layerKey,
  color,
  compact = false,
  active = false,
  count,
  loading = false,
  locked = false,
}: {
  layerKey: keyof LayerVisibility;
  color: string;
  compact?: boolean;
  active?: boolean;
  count?: number;
  loading?: boolean;
  locked?: boolean;
}) {
  const key = layerKey as TrimmedPulseLayerKey;
  const coverage = getTrimmedPulseCoverage(key);
  const mode = getTrimmedPulseLayerModeLabel(key);
  const dataStatus = useLayerDataStatus(layerKey); // 靜態/PMTiles 層的來源狀態（error/loading/ready）

  // 資料狀態徽章優先序：不支援 > 來源載入失敗 > 載入中 > 此視野無資料（count===0）。
  const RED = { fg: "#fca5a5", bg: "rgba(248,113,113,0.15)", bd: "rgba(248,113,113,0.55)" };
  const BLUE = { fg: "#93c5fd", bg: "rgba(147,197,253,0.14)", bd: "rgba(147,197,253,0.5)" };
  const GREY = { fg: "#cbd5e1", bg: "rgba(148,163,184,0.16)", bd: "rgba(148,163,184,0.45)" };
  const ORANGE = { fg: "#fdba74", bg: "rgba(251,146,60,0.14)", bd: "rgba(251,146,60,0.5)" };
  let status: { text: string; fg: string; bg: string; bd: string } | null = null;
  if (coverage) {
    status = { text: `此區無資料 · ${coverage.label}`, ...ORANGE };
  } else if (active && !locked) {
    if (dataStatus === "error") {
      status = { text: "資料載入失敗", ...RED };
    } else if (loading || dataStatus === "loading") {
      status = { text: "載入中…", ...BLUE };
    } else if (dataStatus === "empty" || count === 0) {
      status = { text: "此視野無資料", ...GREY };
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 4,
        marginTop: compact ? 1 : 2,
        fontSize: compact ? 10 : 11,
        lineHeight: 1.25,
        color: "rgba(156,163,175,0.92)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "1px 4px",
          borderRadius: 4,
          border: `1px solid ${color}66`,
          color,
          whiteSpace: "nowrap",
        }}
      >
        {mode}
      </span>
      {status && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "1px 5px",
            borderRadius: 4,
            border: `1px solid ${status.bd}`,
            background: status.bg,
            color: status.fg,
            whiteSpace: "nowrap",
            fontWeight: 500,
          }}
        >
          {status.text}
        </span>
      )}
      {coverage && !compact && <span>原因：{coverage.reason}</span>}
    </div>
  );
}
