/** A Custom canvas of `width` × `height` layer units centred on the origin, fitted to the screen (`sceneLayerCreate.canvas`). */
export function layerCanvas(width: number, height: number) {
  return {
    design: { sizeMode: "custom" as const, customSizePx: { width: width * 100, height: height * 100 }, rootAnchor: "center" as const, scaling: "fitToScreen" as const },
    rect: { width, height, center: [0, 0] as [number, number] },
  };
}
