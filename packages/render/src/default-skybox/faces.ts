import type { SkyboxFaceKey } from "@babylonslate/core";

const ENGINE_DEFAULT_SKYBOX_PUBLIC_DIR = "engine-content/skybox";

function viteBaseUrl(): string {
  if (typeof import.meta === "undefined") {
    return "/";
  }
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? "/";
}

/** Public URL for an engine default cubemap face (`px` … `nz`). */
export function engineDefaultSkyboxFaceUrl(
  face: SkyboxFaceKey,
  baseUrl = viteBaseUrl(),
): string {
  const base =
    !baseUrl || baseUrl === ""
      ? "/"
      : baseUrl.endsWith("/")
        ? baseUrl
        : `${baseUrl}/`;
  return `${base}${ENGINE_DEFAULT_SKYBOX_PUBLIC_DIR}/${face}.png`;
}
