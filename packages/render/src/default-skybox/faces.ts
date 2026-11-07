import type { SkyboxFaceKey } from "@haptic/core";
import { engineContentUrl } from "../engine-content-url";

const ENGINE_DEFAULT_SKYBOX_PUBLIC_DIR = "engine-content/skybox";

/** Public URL for an engine default cubemap face (`px` … `nz`). */
export function engineDefaultSkyboxFaceUrl(face: SkyboxFaceKey): string {
  return engineContentUrl(ENGINE_DEFAULT_SKYBOX_PUBLIC_DIR, `${face}.png`);
}
