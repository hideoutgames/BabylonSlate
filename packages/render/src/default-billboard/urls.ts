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

export type EngineBillboardFile = (typeof ENGINE_BILLBOARD_FILES)[number];

function viteBaseUrl(): string {
  if (typeof import.meta === "undefined") {
    return "/";
  }
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? "/";
}

function withTrailingSlash(baseUrl: string): string {
  if (!baseUrl || baseUrl === "") return "/";
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/** Public URL for an engine editor billboard PNG (`default`, `point_light`, …). */
export function engineBillboardUrl(
  name: string,
  baseUrl = viteBaseUrl(),
): string {
  const file = name.endsWith(".png") ? name : `${name}.png`;
  return `${withTrailingSlash(baseUrl)}${ENGINE_BILLBOARD_PUBLIC_DIR}/${file}`;
}
