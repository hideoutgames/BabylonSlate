export const SCENE_MODES = ["design", "landscape", "foliage"] as const;
export type SceneMode = (typeof SCENE_MODES)[number];

export const SCENE_MODE_LABELS: Record<SceneMode, string> = {
  design: "Design",
  landscape: "Landscape",
  foliage: "Foliage",
};

export type SceneDocumentLayout = {
  sceneMode: SceneMode;
} & Record<SceneMode, Record<string, unknown> | null>;

export function normalizeSceneMode(value: unknown): SceneMode {
  return value === "landscape" || value === "foliage" ? value : "design";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Existing raw DockView layouts become the Design layout without losing panels. */
export function parseSceneDocumentLayout(
  layout: Record<string, unknown> | null | undefined,
): SceneDocumentLayout {
  if (layout && "sceneMode" in layout) {
    return {
      sceneMode: normalizeSceneMode(layout.sceneMode),
      design: record(layout.design),
      landscape: record(layout.landscape),
      foliage: record(layout.foliage),
    };
  }
  return { sceneMode: "design", design: layout ?? null, landscape: null, foliage: null };
}
