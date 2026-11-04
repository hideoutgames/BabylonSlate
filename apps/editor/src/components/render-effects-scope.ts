import type { RenderEffectsOverrides, RenderEffectsSettings } from "@haptic/core";

/** One effects field: a top-level key, or a group key and its leaf. */
export type EffectsPath = readonly [key: keyof RenderEffectsSettings, leaf?: string];
export type EffectsChange = readonly [path: EffectsPath, value: unknown];

/**
 * Where the Post Processing rows write: the project's effects, or a Scene's
 * sparse overrides of them. Rows read `value` either way.
 */
export interface EffectsScope {
  /** Prefix of every row's id and test id. */
  idPrefix: "project-effects" | "scene-effects";
  /** What the rows show: the project's effects, with the Scene's overrides applied in a Scene. */
  value: RenderEffectsSettings;
  /** Applies the changes as one edit. */
  set(...changes: EffectsChange[]): void;
  /** In a Scene: the project value each row follows, and its override state. */
  scene?: {
    project: RenderEffectsSettings;
    overridden(path: EffectsPath): boolean;
    /** Override starts from the shown value; Reset To Project removes the override. */
    toggle(path: EffectsPath): void;
  };
}

export function readEffect(settings: RenderEffectsSettings | RenderEffectsOverrides, [key, leaf]: EffectsPath): unknown {
  const value = (settings as Record<string, unknown>)[key];
  if (leaf === undefined) return value;
  return value && typeof value === "object" ? (value as Record<string, unknown>)[leaf] : undefined;
}

function withEffect<T extends object>(settings: T, [key, leaf]: EffectsPath, value: unknown): T {
  const source = settings as Record<string, unknown>;
  if (leaf === undefined) return { ...source, [key]: value } as T;
  return { ...source, [key]: { ...(source[key] as Record<string, unknown> | undefined), [leaf]: value } } as T;
}

function withoutEffect(overrides: RenderEffectsOverrides, [key, leaf]: EffectsPath): RenderEffectsOverrides {
  const next = { ...overrides } as Record<string, unknown>;
  if (leaf === undefined) {
    delete next[key];
    return next as RenderEffectsOverrides;
  }
  const group = { ...(next[key] as Record<string, unknown> | undefined) };
  delete group[leaf];
  if (Object.keys(group).length > 0) next[key] = group;
  else delete next[key];
  return next as RenderEffectsOverrides;
}

export function projectEffectsScope(
  project: RenderEffectsSettings,
  onChange: (value: RenderEffectsSettings) => void,
): EffectsScope {
  return {
    idPrefix: "project-effects",
    value: project,
    set: (...changes) => onChange(changes.reduce((next, [path, value]) => withEffect(next, path, value), project)),
  };
}

/** `value` is the project's effects with `overrides` applied (`resolveRenderEffectsSettings`). */
export function sceneEffectsScope(
  project: RenderEffectsSettings,
  value: RenderEffectsSettings,
  overrides: RenderEffectsOverrides,
  onChange: (overrides: RenderEffectsOverrides) => void,
): EffectsScope {
  const overridden = (path: EffectsPath) => readEffect(overrides, path) !== undefined;
  return {
    idPrefix: "scene-effects",
    value,
    set: (...changes) => onChange(changes.reduce((next, [path, entry]) => withEffect(next, path, entry), overrides)),
    scene: {
      project,
      overridden,
      toggle: (path) => onChange(overridden(path) ? withoutEffect(overrides, path) : withEffect(overrides, path, readEffect(value, path))),
    },
  };
}
