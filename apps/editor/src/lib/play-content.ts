import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";

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

function sizeFrom(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { width?: unknown; height?: unknown };
  const width = record.width;
  const height = record.height;
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** Hydrate a UserInterface document from an open asset payload. */
export function asUiDocument(value: unknown): UserInterfaceDocument {
  const record = asRecord(value);
  const designResolution =
    sizeFrom(record.designResolution) ?? { width: 1920, height: 1080 };
  return {
    name: typeof record.name === "string" ? record.name : "HUD",
    rootId: typeof record.rootId === "string" ? record.rootId : "canvas",
    designResolution,
    desiredSize:
      sizeFrom(record.desiredSize) ?? { ...designResolution },
    scaleRule:
      record.scaleRule === "fitWidth" || record.scaleRule === "fitHeight"
        ? record.scaleRule
        : "shortestSide",
    viewportLayer: record.viewportLayer !== false,
    widgets: asRecord(record.widgets) as UserInterfaceDocument["widgets"],
  };
}

export type PlayHudInstance = { instanceId: string; assetGuid: string };

export type PlayUiLibrary = Record<string, UserInterfaceDocument>;

export function playUiLibraryFromAssets(
  assets: ReadonlyArray<{ guid: string; path: string; type: string }>,
  contentByPath: (path: string) => unknown | null,
): PlayUiLibrary {
  const library: PlayUiLibrary = {};
  for (const asset of assets) {
    if (asset.type !== "UserInterface") continue;
    const content = contentByPath(asset.path);
    if (!content) continue;
    library[asset.guid] = asUiDocument(content);
  }
  return library;
}

export function applyPlayHudInstance(
  instances: readonly PlayHudInstance[],
  instanceId: string,
  assetGuid: string,
): PlayHudInstance[] {
  const id = instanceId.trim();
  const guid = assetGuid.trim();
  if (!id || !guid) return [...instances];
  if (instances.some((entry) => entry.instanceId === id)) return [...instances];
  return [...instances, { instanceId: id, assetGuid: guid }];
}

export function removePlayHudInstance(
  instances: readonly PlayHudInstance[],
  instanceId: string,
): PlayHudInstance[] {
  return instances.filter((entry) => entry.instanceId !== instanceId);
}

export function resolvePlayHudDocuments(
  instances: readonly PlayHudInstance[],
  library: PlayUiLibrary,
): Array<{ instanceId: string; document: UserInterfaceDocument }> {
  const resolved: Array<{ instanceId: string; document: UserInterfaceDocument }> =
    [];
  for (const entry of instances) {
    const document = library[entry.assetGuid];
    if (document) resolved.push({ instanceId: entry.instanceId, document });
  }
  return resolved;
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
