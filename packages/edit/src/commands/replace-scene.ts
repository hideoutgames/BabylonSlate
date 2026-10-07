import type { SerializedScene } from "@babylonslate/core";
import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

// Inversion shares immutable snapshots, including their measured cost. The
// cache does not retain scenes after their commands leave history.
const snapshots = new WeakMap<SerializedScene, number>();

/** Reject data JSON would silently omit, coerce, or turn into another value. */
function cloneJson(value: unknown, path: string, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || value === null || depth > 128 || ancestors.has(value)) {
    throw new Error(`Scene transaction requires canonical JSON data at ${path}.`);
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`Scene transaction cannot retain a runtime object at ${path}.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`Scene transaction cannot retain symbol properties at ${path}.`);
  }
  ancestors.add(value);
  try {
    const source = Object.getOwnPropertyDescriptors(value);
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(source);
    const allowedKeys = array ? new Set(keys) : null;
    if (allowedKeys && Object.keys(source).some((key) => key !== "length" && !allowedKeys.has(key))) {
      throw new Error(`Scene transaction cannot retain array properties at ${path}.`);
    }
    const result: unknown[] | Record<string, unknown> = array ? [] : {};
    for (const key of keys) {
      const descriptor = source[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`Scene transaction requires a data property at ${path}.${key}.`);
      }
      Object.defineProperty(result, key, {
        value: cloneJson(descriptor.value, `${path}.${key}`, ancestors, depth + 1),
        enumerable: true, configurable: true, writable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function capture(scene: SerializedScene): SerializedScene {
  if (snapshots.has(scene)) return scene;
  const snapshot = cloneJson(scene, "scene") as SerializedScene;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
    typeof snapshot.name !== "string" || (snapshot.viewportMode !== "2d" && snapshot.viewportMode !== "3d") ||
    !snapshot.settings || typeof snapshot.settings !== "object" || Array.isArray(snapshot.settings) ||
    !Array.isArray(snapshot.actors) || !Array.isArray(snapshot.folders)) {
    throw new Error("Scene transaction requires a complete scene document.");
  }
  snapshots.set(snapshot, snapshotBytes(snapshot));
  return snapshot;
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
}

/**
 * Whole-document transaction for already validated, bounded canonical scenes.
 * It preserves fields that ordinary scene deltas do not yet represent. Domain
 * validation, reference ownership and document revision checks belong to callers.
 */
export class ReplaceSceneCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.replace";
  readonly from: SerializedScene;
  readonly to: SerializedScene;
  readonly byteSize: number;

  constructor(from: SerializedScene, to: SerializedScene) {
    this.from = capture(from);
    this.to = from === to ? this.from : capture(to);
    this.byteSize = snapshots.get(this.from)! + snapshots.get(this.to)!;
  }

  apply(doc: SerializedScene): SerializedScene {
    return equalJson(doc, this.to) ? doc : structuredClone(this.to);
  }

  invert(): ReplaceSceneCommand {
    return new ReplaceSceneCommand(this.to, this.from);
  }
}

export function createReplaceSceneCommandFromJson(payload: Record<string, unknown>): ReplaceSceneCommand {
  return new ReplaceSceneCommand(payload.from as SerializedScene, payload.to as SerializedScene);
}
