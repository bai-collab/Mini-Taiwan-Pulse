// ⚠️ 必須是第一行：注入 maplibregl.MercatorCoordinate 給 utils/coordinates
// （EM-16 引擎注入改造；早於 MapView 建 map 與任何 Three 場景求值）
import "./utils/mercatorEngineMaplibre";
import { StrictMode, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { ChiayiStudentApp } from "./chiayiStudent/ChiayiStudentApp";

function FullPulseLoader() {
  const [FullPulse, setFullPulse] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void import("./App")
      .then(({ FullPulseApp }) => {
        if (active) setFullPulse(() => FullPulseApp);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, []);

  if (failed) return <div role="alert" style={{ padding: 24, color: "#ffd5d5", background: "#06111f" }}>完整 Pulse 介面載入失敗。</div>;
  if (!FullPulse) return <div role="status" style={{ padding: 24, color: "#d9fbff", background: "#06111f" }}>正在載入完整 Pulse 介面…</div>;
  return <FullPulse />;
}

const surface = new URLSearchParams(window.location.search).get("surface");

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

// 精簡 Pulse 為產品主體：預設載入 FullPulseApp。
// 舊學生 MVP 保留為回退，移至 ?surface=student（不刪除，符合計畫）。
createRoot(rootEl).render(
  <StrictMode>
    {surface === "student" ? <ChiayiStudentApp /> : <FullPulseLoader />}
  </StrictMode>,
);
