import { engineContentUrl } from "../engine-content-url";

const ENGINE_BILLBOARD_PUBLIC_DIR = "engine-content/billboards";

export { ENGINE_BILLBOARD_FILES } from "./files";

/** Public URL for an engine editor billboard PNG (`default`, `point_light`, …). */
export function engineBillboardUrl(name: string): string {
  return engineContentUrl(ENGINE_BILLBOARD_PUBLIC_DIR, name.endsWith(".png") ? name : `${name}.png`);
}
