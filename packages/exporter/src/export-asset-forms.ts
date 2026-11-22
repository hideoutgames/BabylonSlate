import type { AssetType } from "@haptic/core";

/**
 * How an asset type ships in a game:
 * - `json`: its document, stripped of editor-only fields (`stripEditorOnlyFields`), parsed when loaded.
 * - `bytes`: its binary payload as stored.
 * - `catalog`: a catalog entry with no file. The game never reads the document (a Class runs from its compiled script
 *   sidecars; Input, Save Game and Skeleton data already sit in `game.json` or the Model payload; the rest is
 *   compile-time or editor data), but its guid stays loadable for dependency edges and scripts that name it.
 * - `omit`: never in an export (editor-only types the closure already drops).
 *
 * Exhaustive over `AssetType`, so a new type cannot ship without a decision.
 */
export const EXPORT_ASSET_FORMS = {
  Scene: "json",
  SceneLayer: "json",
  Class: "catalog",
  Prefab: "catalog",
  Font: "bytes",
  Sprite: "json",
  SpriteAnimation: "json",
  AnimationGraph3D: "json",
  BlendSpace: "json",
  SpriteBlendSpace: "json",
  AnimationGraph2D: "json",
  BehaviourTree: "json",
  Blackboard: "json",
  SaveGame: "catalog",
  Material: "json",
  MaterialFunction: "json",
  MaterialInstance: "json",
  Tileset: "json",
  Tilemap: "json",
  Enum: "json",
  Structure: "json",
  DataDefinition: "json",
  DataTree: "json",
  GlobalParameterCollection: "json",
  FloatCurve: "json",
  VectorCurve: "json",
  ColorCurve: "json",
  Timeline: "catalog",
  TimelineClip2D: "json",
  TimelineClip3D: "json",
  ScriptInterface: "catalog",
  PluginSettings: "omit",
  Audio: "bytes",
  InputAction: "catalog",
  InputAxis: "catalog",
  AudioMixer: "json",
  AudioChannel: "json",
  SoundAttenuation: "json",
  CameraShake: "json",
  ParticleEmitter: "json",
  ParticleGraph: "json",
  ParticleSystem: "json",
  Water: "json",
  Model: "bytes",
  Skeleton: "catalog",
  Animation: "json",
  SkyboxCreator: "omit",
  Trace: "catalog",
  Texture: "bytes",
  RenderTarget: "json",
  RenderTargetTexture: "json",
} as const satisfies Record<AssetType, "json" | "bytes" | "catalog" | "omit">;

export type ExportAssetForm = (typeof EXPORT_ASSET_FORMS)[AssetType];

/** A built-in asset type's form; null for generated entries (compiled scripts, sidecars), which carry their own encoding. */
export function exportAssetForm(type: string): ExportAssetForm | null {
  return Object.hasOwn(EXPORT_ASSET_FORMS, type) ? EXPORT_ASSET_FORMS[type as AssetType] : null;
}

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((entry): entry is Row => !!entry && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function without(row: Row, keys: readonly string[]): Row {
  const next = { ...row };
  for (const key of keys) delete next[key];
  return next;
}

/**
 * Editor-only fields no game code reads, by asset type: the Scene and Scene Layer outliner (`folders`, `folderId`),
 * prefab link bookkeeping (`prefabGuid`, `overrideKeys`), viewport settings, the raw embedded script graph (its compiled
 * sidecar ships), and preview and description fields of Materials, Animation Graphs and Particle Systems. Fields the
 * runtime does read stay, even when they look editor-only: `locked` (an actor variable), `sourceId` and
 * `suppressedComponentSourceIds` (prefab component identity), `foliageGroups` (foliage rendering).
 */
const STRIPPED_FIELDS = {
  scene: ["script", "folders"],
  sceneSettings: ["grid", "editorJoystickEnabled", "showNavmesh"],
  actor: ["folderId", "prefabGuid"],
  component: ["overrideKeys"],
  material: ["preview", "description"],
  animGraph: ["previewModelGuid"],
  particleSystem: ["previewSkybox"],
} as const;

/** One export-time pass: the document without its type's editor-only fields (`STRIPPED_FIELDS`). */
export function stripEditorOnlyFields(type: string, document: unknown): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const row = document as Row;
  switch (type) {
    case "Scene":
    case "SceneLayer": {
      const next = without(row, STRIPPED_FIELDS.scene);
      if (next.settings && typeof next.settings === "object" && !Array.isArray(next.settings)) {
        next.settings = without(next.settings as Row, STRIPPED_FIELDS.sceneSettings);
      }
      if (Array.isArray(row.actors)) {
        next.actors = rows(row.actors).map((actor) => {
          const stripped = without(actor, STRIPPED_FIELDS.actor);
          if (Array.isArray(actor.components)) stripped.components = rows(actor.components).map((component) => without(component, STRIPPED_FIELDS.component));
          return stripped;
        });
      }
      return next;
    }
    case "Material":
    case "MaterialFunction":
    case "MaterialInstance":
      return without(row, STRIPPED_FIELDS.material);
    case "AnimationGraph3D":
    case "AnimationGraph2D":
      return without(row, STRIPPED_FIELDS.animGraph);
    case "ParticleSystem":
      return without(row, STRIPPED_FIELDS.particleSystem);
    default:
      return document;
  }
}
