import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  createDefaultPlayHud,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";

export interface PlayContentDocument {
  id: string;
  ref: { kind: string; path: string };
  content: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Hydrate a UserInterface document from an open asset payload. */
export function asUiDocument(value: unknown): UserInterfaceDocument {
  const record = asRecord(value);
  return {
    name: typeof record.name === "string" ? record.name : "HUD",
    rootId: typeof record.rootId === "string" ? record.rootId : "canvas",
    designResolution:
      record.designResolution && typeof record.designResolution === "object"
        ? (record.designResolution as UserInterfaceDocument["designResolution"])
        : { width: 1920, height: 1080 },
    scaleRule:
      record.scaleRule === "fitWidth" || record.scaleRule === "fitHeight"
        ? record.scaleRule
        : "shortestSide",
    viewportLayer: record.viewportLayer !== false,
    widgets: asRecord(record.widgets) as UserInterfaceDocument["widgets"],
  };
}

function findOpenUiDocument(
  documents: readonly PlayContentDocument[],
  activeDocumentId: string | null,
): PlayContentDocument | undefined {
  const active = documents.find((entry) => entry.id === activeDocumentId);
  if (active?.ref.kind === "ui") return active;
  return documents.find((entry) => entry.ref.kind === "ui");
}

/**
 * Active (or first) open viewport-layer UserInterface for Play.
 * Falls back to the default HUD when none is open — same pattern as
 * `playSceneFromOpenDocuments`. Full project-registry hosting stays later.
 */
export function playHudFromOpenDocuments(
  documents: readonly PlayContentDocument[],
  activeDocumentId: string | null,
): UserInterfaceDocument {
  const open = findOpenUiDocument(documents, activeDocumentId);
  if (!open?.content) return createDefaultPlayHud("HUD");
  const hud = asUiDocument(open.content);
  if (!hud.viewportLayer || Object.keys(hud.widgets).length === 0) {
    return createDefaultPlayHud("HUD");
  }
  return hud;
}

export type PlayAnimGraphEntry = { guid: string; document: unknown };

/**
 * Open AnimationGraph documents for the worker `loadAnimGraphs` control.
 * `guidForPath` maps the asset path to the registry guid (graphGuid).
 */
export function playAnimGraphsFromOpenDocuments(
  documents: readonly PlayContentDocument[],
  guidForPath: (path: string) => string | null,
): PlayAnimGraphEntry[] {
  const graphs: PlayAnimGraphEntry[] = [];
  for (const entry of documents) {
    if (entry.ref.kind !== "anim-graph" || !entry.content) continue;
    const parsed = parseAnimGraphDocument(entry.content);
    if (!parsed) continue;
    const guid = guidForPath(entry.ref.path) ?? entry.ref.path;
    graphs.push({ guid, document: parsed });
  }
  return graphs;
}
