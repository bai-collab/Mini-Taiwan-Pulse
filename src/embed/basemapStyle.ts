import { OPENFREEMAP_LIBERTY_STYLE } from "../components/StyleSelector";

/** 無 key、無本機 PMTiles 依賴的共用底圖。 */
export function buildBasemapStyle(_isDark: boolean): string {
  return OPENFREEMAP_LIBERTY_STYLE;
}
