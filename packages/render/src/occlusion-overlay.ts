/**
 * The `showocclusion` overlay: draws a world view's occlusion buffer (`sceneOcclusionBuffer`) into a 2D canvas the host
 * places over the view, so the debug view compiles no shader. Near occluders draw light, far ones dark, and texels no
 * occluder covers stay clear.
 */
export function drawOcclusionOverlay(
  canvas: HTMLCanvasElement,
  buffer: { width: number; height: number; depth: Float32Array },
): void {
  const { width, height, depth } = buffer;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  let far = 0;
  for (const value of depth) if (value !== Infinity && value > far) far = value;
  const image = context.createImageData(width, height);
  const pixels = image.data;
  for (let index = 0; index < width * height; index++) {
    const value = depth[index]!;
    if (value === Infinity) continue;
    // Depth on a square-root scale, so near detail keeps contrast.
    const shade = Math.round(255 * (1 - 0.8 * Math.sqrt(value / Math.max(far, 1e-6))));
    pixels[index * 4] = shade;
    pixels[index * 4 + 1] = Math.round(shade * 0.85);
    pixels[index * 4 + 2] = 64;
    pixels[index * 4 + 3] = 170;
  }
  context.putImageData(image, 0, 0);
}
