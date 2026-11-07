/**
 * How a Sprite or Tilemap draws: lit by its Scene's 2D Lights (unlit while the Scene has none), lit by 3D lights as a
 * Material surface is, or always unlit.
 */
export type SurfaceShadingMode = "2d" | "3d" | "unlit";
export const SURFACE_SHADING_MODES: readonly SurfaceShadingMode[] = ["2d", "3d", "unlit"];

/** The components that carry a Shading Mode (`shadingMode`). */
export const SHADING_MODE_CLASS_IDS: ReadonlySet<string> = new Set(["SpriteComponent", "TilemapComponent"]);

export function parseSurfaceShadingMode(value: unknown): SurfaceShadingMode {
  return value === "3d" || value === "unlit" ? value : "2d";
}
