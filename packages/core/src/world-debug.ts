/**
 * Whole-frame ablation switches for Play's world (the `worlddebug` console command), each sizing one share of the main
 * colour pass: `world` (no world mesh drawn by the view's passes), `lighting` (lit surfaces draw their base colour),
 * `shadowtaps` (shadow maps still drawn, every lookup lit), `locallights` (sun, fill and environment only) and `shading`
 * (every surface one constant colour). Debug only, never saved.
 */
export const WORLD_DEBUG_PARTS = ["world", "lighting", "shadowtaps", "locallights", "shading"] as const;
export type WorldDebugPart = (typeof WORLD_DEBUG_PARTS)[number];
