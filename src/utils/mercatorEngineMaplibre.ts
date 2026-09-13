/**
 * 主站的 Mercator 引擎注入（side-effect only）。
 *
 * 這個模組必須在建立地圖與任何 Three.js Scene 前求值，讓共用座標工具
 * 不需要直接依賴任何地圖引擎的 runtime 模組。
 */
import maplibregl from "maplibre-gl";
import { setMercatorEngine } from "./coordinates";

setMercatorEngine(maplibregl.MercatorCoordinate);
