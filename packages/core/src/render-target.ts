import { parseMapDefaultEntries } from "./map-default";
import type { GraphClassMember, SerializedGraph } from "./project";

/** Babylon-free render capture contracts shared by authoring and exported games. */
export const ENGINE_RENDER_TARGET_MODE_ENUM_ID = "engine:RenderTargetMode";
export const RENDER_TARGET_MODES = ["SceneColor", "DepthPass", "WorldNormal"] as const;
export type RenderTargetMode = (typeof RENDER_TARGET_MODES)[number];
export const RENDER_TARGET_MODE_LABELS: Record<RenderTargetMode, string> = {
  SceneColor: "Scene Color",
  DepthPass: "Depth Pass",
  WorldNormal: "World Normal",
};

export type RenderTargetPayload = {
  mode: RenderTargetMode;
  width: number;
  height: number;
};

/** A material sampler asset referencing the live output of a Render Target. */
export type RenderTargetTexturePayload = { renderTargetGuid: string | null };

export type RenderTargetCaptureProperties = {
  renderTargetGuid: string | null;
  enabled: boolean;
  captureEveryFrame: boolean;
  captureOnlyActors: boolean;
  /** Serialized actor ids; graph APIs expose live Actor references. */
  actorIds: string[];
  fieldOfView: number;
  nearClip: number;
  farClip: number;
};
export type RenderTargetCaptureProperty = keyof RenderTargetCaptureProperties;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function nullableGuid(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
}

export function createDefaultRenderTargetPayload(): RenderTargetPayload {
  return { mode: "SceneColor", width: 512, height: 512 };
}
export function normalizeRenderTargetPayload(value: unknown): RenderTargetPayload {
  const source = record(value);
  return {
    mode: (RENDER_TARGET_MODES as readonly unknown[]).includes(source.mode)
      ? source.mode as RenderTargetMode : "SceneColor",
    width: Math.round(finite(source.width, 512, 1, 4096)),
    height: Math.round(finite(source.height, 512, 1, 4096)),
  };
}
export function createDefaultRenderTargetTexturePayload(): RenderTargetTexturePayload {
  return { renderTargetGuid: null };
}
export function normalizeRenderTargetTexturePayload(value: unknown): RenderTargetTexturePayload {
  return { renderTargetGuid: nullableGuid(record(value).renderTargetGuid) };
}
export function createDefaultRenderTargetCaptureProperties(): RenderTargetCaptureProperties {
  return {
    renderTargetGuid: null,
    enabled: true,
    captureEveryFrame: true,
    captureOnlyActors: false,
    actorIds: [],
    fieldOfView: 60,
    nearClip: 0.1,
    farClip: 1000,
  };
}
export function normalizeRenderTargetCaptureProperties(value: unknown): RenderTargetCaptureProperties {
  const source = record(value);
  const nearClip = finite(source.nearClip, 0.1, 0.001, 999999);
  return {
    renderTargetGuid: nullableGuid(source.renderTargetGuid),
    enabled: source.enabled !== false,
    captureEveryFrame: source.captureEveryFrame !== false,
    captureOnlyActors: source.captureOnlyActors === true,
    actorIds: [...new Set((Array.isArray(source.actorIds) ? source.actorIds : [])
      .flatMap((entry) => { const id = nullableGuid(entry); return id ? [id] : []; }))],
    fieldOfView: finite(source.fieldOfView, 60, 1, 179),
    nearClip,
    farClip: Math.max(nearClip + 0.001, finite(source.farClip, 1000, 0.002, 1000000)),
  };
}

/** Both authored image textures and live render output satisfy material 2D samplers. */
export function isMaterialTextureAssetType(type: string): boolean {
  return type === "Texture" || type === "RenderTargetTexture";
}

/** Asset references stored in graph defaults are part of the export dependency closure. */
export function renderTargetAssetGuidsFromGraph(graph: SerializedGraph): string[] {
  const guids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) guids.add(value.trim());
  };
  const isTarget = (type?: string): boolean => type === "RenderTarget" || type === "RenderTargetTexture";
  const collectDefault = (row: Partial<GraphClassMember>, value: unknown, includeTexture = false): void => {
    const accepts = (type?: string): boolean => isTarget(type) || (includeTexture && type === "Texture");
    const valueRef = row.typeId === "asset" && accepts(row.typeClassId);
    if (row.container === "map") {
      for (const entry of parseMapDefaultEntries(value)) {
        if (row.keyTypeId === "asset" && accepts(row.keyTypeClassId)) add(entry.key);
        if (valueRef) add(entry.value);
      }
    } else if (valueRef && row.container === "array") {
      if (Array.isArray(value)) value.forEach(add);
    } else if (valueRef) add(value);
  };
  for (const row of graph.members ?? []) {
    if (row.kind === "variable") collectDefault(row, row.defaultValue);
  }
  for (const slice of [graph, ...Object.values(graph.functionGraphs ?? {})]) {
    for (const node of slice.nodes ?? []) {
      const nested = node.data?.properties;
      const props = nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested as Record<string, unknown> : node.data ?? {};
      const names = node.type === "render-target.getMode" ? ["target", "Render Target"]
        : node.type === "render-target.getTextureTarget" ? ["texture", "Texture"]
          : node.type === "render-target.setRenderTarget" ? ["value", "Render Target"]
            : node.type === "variables.set" ? ["value", typeof props.variableName === "string" ? props.variableName : "Value"] : null;
      if (!names) continue;
      // Canonical cleared defaults mask legacy id/name values, as in codegen.
      const value = names.flatMap((name) => [`default:${name}`, name])
        .map((key) => props[key]).find((entry) => entry !== undefined);
      if (node.type === "variables.set") {
        // Texture pins can carry a RenderTargetTexture, including container entries.
        collectDefault(props as Partial<GraphClassMember>, value, true);
      } else add(value);
    }
  }
  return [...guids];
}
