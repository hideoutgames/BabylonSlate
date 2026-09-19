/**
 * Managed-GPU byte accounting for one baked irradiance atlas lease. The
 * source asset stays rgba32float-le; the upload narrows to RGBA16F (8 bytes
 * per texel) because it is filterable on every supported backend. WebGPU's
 * texture manager also keeps a same-size mapped staging buffer — but only
 * when the 8-byte row pitch is already 256-aligned; otherwise it repacks
 * rows through a padded copy that needs no atlas-shaped staging. Keeping
 * this pure lets the e2e spec derive expectations from the same rule.
 */
export function bakedAtlasGpuBytes(
  width: number,
  height: number,
  webgpu: boolean,
): number {
  const bytes = width * height * 8;
  return bytes + (webgpu && (width * 8) % 256 === 0 ? bytes : 0);
}
