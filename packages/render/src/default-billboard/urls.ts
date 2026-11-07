import { engineContentUrl } from "../engine-content-url";

const ENGINE_BILLBOARD_PUBLIC_DIR = "engine-content/billboards";

export const ENGINE_BILLBOARD_FILES = [
  "default.png",
  "directional_light.png",
  "spot_light.png",
  "point_light.png",
  "audio.png",
  "camera.png",
  "particles.png",
  "navmesh.png",
] as const;

/** Public URL for an engine editor billboard PNG (`default`, `point_light`, …). */
export function engineBillboardUrl(name: string): string {
  return engineContentUrl(ENGINE_BILLBOARD_PUBLIC_DIR, name.endsWith(".png") ? name : `${name}.png`);
}
