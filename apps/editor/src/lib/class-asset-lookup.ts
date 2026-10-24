/**
 * Class-asset id and ancestry helpers that app boot (document-context, project
 * service) needs. They live apart from `content-browser-helpers`, whose asset
 * factories pull in every graph package, so the boot path can import them
 * without that module. `content-browser-helpers` re-exports everything here.
 */
import type { AssetRegistry } from "@haptic/assets";
import { engineParentOf, walkAncestry } from "@haptic/editor-kit";
import { isSceneAssetClassId } from "@haptic/object-model";
import { classIdForGraphPath } from "../services/script-compiler";
import type { CreatableAssetType } from "./content-browser-helpers";

export type ClassAssetRef = {
  path?: string;
  header: {
    type: string;
    name: string;
    parentClass?: string | null;
    guid?: string;
    payload?: Record<string, unknown>;
    requiredVariableNames?: readonly string[];
  };
};

const ASSET_FILE_SUFFIX: Partial<Record<CreatableAssetType, string>> = {
  Scene: ".scene.hasset",
  SceneLayer: ".scenelayer.hasset",
  Class: ".class.hasset",
  Prefab: ".prefab.hasset",
  Sprite: ".sprite.hasset",
  SpriteAnimation: ".spriteanim.hasset",
  AnimationGraph: ".anim.hasset",
  Material: ".material.hasset",
  MaterialFunction: ".matfunc.hasset",
  MaterialInstance: ".matinst.hasset",
  Tileset: ".tileset.hasset",
  Tilemap: ".tilemap.hasset",
  BehaviourTree: ".bt.hasset",
  Blackboard: ".blackboard.hasset",
  SaveGame: ".savegame.hasset",
  AudioMixer: ".mixer.hasset",
  InputAction: ".inputaction.hasset",
  DataDefinition: ".datadefinition.hasset",
  DataTree: ".datatree.hasset",
  InputAxis: ".inputaxis.hasset",
  AudioChannel: ".channel.hasset",
  SoundAttenuation: ".atten.hasset",
  ParticleEmitter: ".emitter.hasset",
  ParticleGraph: ".particlegraph.hasset",
  ParticleSystem: ".particles.hasset",
  Water: ".water.hasset",
  RenderTarget: ".rendertarget.hasset",
  RenderTargetTexture: ".rendertargettexture.hasset",
  SkyboxCreator: ".skyboxcreator.hasset",
};

/** File suffix a new asset of this type is written with. */
export function newAssetFileSuffix(type: CreatableAssetType): string {
  return ASSET_FILE_SUFFIX[type] ?? ".hasset";
}

export function newAssetFileName(
  type: CreatableAssetType,
  name: string,
): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_");
  if (!safe) return "";
  return `${safe}${newAssetFileSuffix(type)}`;
}

/**
 * Compile class id for a Class asset: its file stem, or without a path the
 * stem New Asset writes for its name (`Rain-Weather` → `Rain_Weather`).
 */
export function classIdFromClassAsset(asset: ClassAssetRef): string {
  return classIdForGraphPath(asset.path ?? newAssetFileName("Class", asset.header.name));
}

export function classParentLookup(
  assets: ReadonlyArray<ClassAssetRef>,
): (id: string) => string | null {
  const byId = new Map<string, string>();
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    // The first file keeps a shared id, as in buildParentClassTreeRows.
    if (!byId.has(id)) byId.set(id, asset.header.parentClass ?? "Object");
  }
  return (id) => {
    if (isSceneAssetClassId(id) && id !== "Scene") return "Scene";
    return byId.get(id) ?? engineParentOf(id) ?? null;
  };
}

const registryParentLookups = new WeakMap<object, { generation: number; parentOf: (id: string) => string | null }>();

/**
 * `classParentLookup(registry.list())`, rebuilt only when the registry's catalog has
 * changed since the last call. Callers on hot paths (Play preparation, dock layout
 * changes) otherwise copy the catalog and re-derive every Class id on each call.
 */
export function registryClassParentLookup(registry: Pick<AssetRegistry, "generation" | "list"> | null | undefined): (id: string) => string | null {
  if (!registry) return classParentLookup([]);
  const generation = registry.generation;
  const cached = registryParentLookups.get(registry);
  if (cached?.generation === generation) return cached.parentOf;
  const parentOf = classParentLookup(registry.list());
  registryParentLookups.set(registry, { generation, parentOf });
  return parentOf;
}

export function classDocumentShowsPrefab(
  parentClass: string | null | undefined,
  parentOf: (id: string) => string | null,
): boolean {
  return walkAncestry(parentClass ?? "Object", parentOf).includes("Actor");
}
