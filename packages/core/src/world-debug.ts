/**
 * Whole-frame ablation switches for Play's world (the `worlddebug` console command), each sizing one share of the main
 * colour pass: `world` (no world mesh drawn by the view's passes), `lighting` (lit surfaces draw their base colour),
 * `shadowtaps` (shadow maps still drawn, every lookup lit), `locallights` (sun, fill and environment only) and `shading`
 * (every surface one constant colour). Two size the geometry pass the screen-space effects read by drawing it once
 * more, the picture unchanged: `geometryonce` (off: a second geometry pass, the same meshes into scratch targets nothing
 * reads, right before the real one) and `geometryoncescissor` (off: that second pass under a 1x1 scissor, so it keeps
 * its draws and vertices and drops its fragments). `spritebatching` off ejects every Play world sprite from its
 * thin-instanced batch to a quad of its own and batches none built after (the picture unchanged, to size what batching
 * saves); back on, sprites built afterwards batch again. `materialrecords` is off by default, unlike the others: on, the
 * Scene's graph Materials compile again to read their parameters and literals from a per-Material uniform block (the
 * Material record), so Materials of one shape share a program, an opt-in that awaits a native-GPU proof that the picture
 * is unchanged. Debug only, never saved.
 */
export const WORLD_DEBUG_PARTS = [
  "world", "lighting", "shadowtaps", "locallights", "shading", "geometryonce", "geometryoncescissor",
  "spritebatching", "materialrecords",
] as const;
export type WorldDebugPart = (typeof WORLD_DEBUG_PARTS)[number];
