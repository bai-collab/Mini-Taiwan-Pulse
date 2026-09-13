import type { CustomRenderMethodInput } from "maplibre-gl";

/**
 * MapLibre custom layer 的第二個 render 參數是物件；舊 Mapbox layer 則直接收到
 * 16 格矩陣。所有既有 Three scene 只需要矩陣，因此在這裡集中做最小轉接。
 * ArrayLike 分支也保留給現有單元測試及 legacy 呼叫者。
 */
export function customLayerMatrix(input: CustomRenderMethodInput | ArrayLike<number>): number[] {
  if (typeof input === "object" && "defaultProjectionData" in input) {
    return Array.from(input.defaultProjectionData.mainMatrix);
  }
  return Array.from(input);
}

export function customLayerProjectionName(input: CustomRenderMethodInput): string | null {
  const variant = input.shaderData.variantName.toLowerCase();
  return variant.includes("globe") ? "globe" : "mercator";
}
