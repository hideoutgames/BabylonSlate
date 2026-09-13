import type { ProjectSettings } from "@babylonslate/core";

export type RenderingDraft = Pick<ProjectSettings, "render" | "playFrameCap" | "playPreview">;
export function renderingDraft(settings: ProjectSettings): RenderingDraft {
  return structuredClone({ render: settings.render, playFrameCap: settings.playFrameCap, playPreview: settings.playPreview });
}
/** Only edited leaves replace the latest project values. Reverted edits disappear. */
export function mergeRenderingDraft(base: RenderingDraft, draft: RenderingDraft, latest: ProjectSettings): RenderingDraft {
  const merge = (before: unknown, after: unknown, current: unknown): unknown => {
    if (JSON.stringify(before) === JSON.stringify(after)) return current;
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(after)) {
      const result = { ...(current as Record<string, unknown>) };
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        result[key] = merge((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], result[key]);
      }
      return result;
    }
    return after;
  };
  return merge(base, draft, renderingDraft(latest)) as RenderingDraft;
}
