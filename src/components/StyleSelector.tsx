import type { MapStyle } from "../types";
import { FONT_DATA, RADIUS, FONT_SIZE } from "../styles/designTokens";

/** 免 token、免綁卡的共用底圖。OpenFreeMap Liberty 供 bbox/embed 沿用；主站用 CARTO GL 免費 style。 */
export const OPENFREEMAP_LIBERTY_STYLE = "https://tiles.openfreemap.org/styles/liberty";
/** CARTO 免費 GL style（免 key）：深色 dark-matter / 淺色 positron。與 App 的 isDarkTheme 對齊，避免深色 UI 疊淺底圖對比不足。 */
const CARTO_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const CARTO_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// 精簡版只保留兩個有意義的底圖，與 App 的 `isDarkTheme = !["light","streets"]` 對齊：
// 深色 id → 深底圖（深色 UI 讀得清楚）、淺色 id → 淺底圖。舊網址的其他 id 由 getStyleUrl fallback 到 [0]（深色）。
export const MAP_STYLES: MapStyle[] = [
  { id: "dark", name: "深色地圖", url: CARTO_DARK },
  { id: "light", name: "淺色地圖", url: CARTO_LIGHT },
];

interface Props {
  selected: string;
  isDarkTheme?: boolean;
  onChange: (styleId: string) => void;
}

const getStyle = (dark: boolean): React.CSSProperties => ({
  background: dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.85)",
  color: dark ? "#fff" : "#333",
  border: `1px solid ${dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.12)"}`,
  borderRadius: RADIUS.md,
  padding: "4px 8px",
  fontSize: FONT_SIZE.md,
  fontFamily: FONT_DATA,
  backdropFilter: "blur(8px)",
});

export function StyleSelector({ selected, isDarkTheme = true, onChange }: Props) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      style={getStyle(isDarkTheme)}
    >
      {MAP_STYLES.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

export function getStyleUrl(id: string): string {
  return MAP_STYLES.find((s) => s.id === id)?.url ?? MAP_STYLES[0]!.url;
}
