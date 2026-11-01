export const SCENE_MODES = ["design", "landscape", "foliage", "script", "timeline"] as const;
export type SceneMode = (typeof SCENE_MODES)[number];

/** A Scene Layer has no Landscape or Foliage. */
export const SCENE_LAYER_MODES = ["design", "script", "timeline"] as const satisfies readonly SceneMode[];

export const SCENE_MODE_LABELS: Record<SceneMode, string> = {
  design: "Design",
  landscape: "Landscape",
  foliage: "Foliage",
  script: "Script",
  timeline: "Timeline",
};

export type SceneDocumentLayout = {
  sceneMode: SceneMode;
} & Record<SceneMode, Record<string, unknown> | null>;

/** Document kinds whose tab switches modes (Scene, Scene Layer). */
export function hasSceneModes(kind: string | undefined): kind is "scene" | "scene-layer" {
  return kind === "scene" || kind === "scene-layer";
}

/** The modes a Scene (all) or Scene Layer (Design, Script, Timeline) tab offers. */
export function sceneModesForKind(kind: string | undefined): readonly SceneMode[] {
  return kind === "scene-layer" ? SCENE_LAYER_MODES : SCENE_MODES;
}

export function normalizeSceneMode(value: unknown, kind?: string): SceneMode {
  return (sceneModesForKind(kind) as readonly unknown[]).includes(value) ? value as SceneMode : "design";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Read the stored `{ sceneMode, design, landscape, foliage, script, timeline }` scene layout. */
export function parseSceneDocumentLayout(
  layout: Record<string, unknown> | null | undefined,
  kind?: string,
): SceneDocumentLayout {
  return {
    sceneMode: normalizeSceneMode(layout?.sceneMode, kind),
    // A Scene Layer tab saved before it had modes stored its DockView layout flat.
    design: record(layout?.design) ?? (layout && !("sceneMode" in layout) && "grid" in layout ? layout : null),
    landscape: record(layout?.landscape),
    foliage: record(layout?.foliage),
    script: record(layout?.script),
    timeline: record(layout?.timeline),
  };
}

/** The active mode of a Scene or Scene Layer tab; undefined for other kinds. */
export function documentSceneMode(
  kind: string | undefined,
  layout: Record<string, unknown> | null | undefined,
): SceneMode | undefined {
  return hasSceneModes(kind) ? parseSceneDocumentLayout(layout, kind).sceneMode : undefined;
}
