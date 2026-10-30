/**
 * New Asset document factories: the `ImportResult` each creatable asset type
 * starts as, and Material Instances made from a parent Material.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import {
  createDataDefinitionAsset,
  createDataTreeAsset,
  createDefaultRenderTargetCaptureProperties,
  createDefaultRenderTargetPayload,
  createDefaultRenderTargetTexturePayload,
  createDefaultSaveGameDefinition,
  createDefaultScene,
  createDefaultSceneLayer,
  createDefaultWaterDefinition,
  createInputAssetPayload,
  createSceneStreamingActor,
  isInputAssetType,
  type DataDefinitionAsset,
  type DataTreeAsset,
  type ViewportMode,
} from "@haptic/core";
import {
  DOCUMENT_CHUNK_ID,
  createDefaultAudioChannelPayload,
  createDefaultAudioMixerPayload,
  createDefaultMigrationRegistry,
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  createDefaultSkyboxCreatorPayload,
  createDefaultSoundAttenuationPayload,
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  type ImportResult,
} from "@haptic/assets";
import { createDefaultAnimGraph } from "@haptic/anim-graph";
import {
  createDefaultBehaviourTree,
  createDefaultBlackboard,
} from "@haptic/behaviour-tree";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  createDefaultMaterialInstanceDocument,
  createWaterMaterialDocument,
  materialInstanceDependencies,
  parseMaterialDomain,
  type MaterialDomain,
} from "@haptic/shader-graph";
import { createDefaultParticleGraphDocument } from "@haptic/particle-graph";
import { engineParentOf, walkAncestry } from "@haptic/editor-kit";
import { isLockedEngineClassId } from "@haptic/object-model";
import { createDefaultLogicGraphSerialized, defaultNodeRegistry } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { assetHeaderDependencies } from "./asset-header-dependencies";
import { newAssetFileName } from "./class-asset-lookup";
import type { CreatableAssetType } from "./content-browser-helpers";
import { defaultPrefabComponents } from "./prefab-preview";

export function defaultParentClassForType(
  type: CreatableAssetType,
): string | null {
  return type === "Class" ? "Object" : null;
}

export function buildNewAssetResult(options: {
  type: CreatableAssetType;
  name: string;
  guid: string;
  parentClass: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, import("@haptic/core").SerializedGraph>;
  /** New Material domain; pickers pass `particle` / `postProcess` / `landscape`. */
  materialDomain?: MaterialDomain;
  /** A new Surface Material starts as the starter Water Material (built-in water's look, wired from the water nodes). */
  waterMaterial?: boolean;
  defaultDefinitionGuid?: string | null;
  dataDefinition?: DataDefinitionAsset;
  dataTree?: DataTreeAsset;
  /** A new Prefab starts empty in a 2D scene, with the starter box in 3D. */
  viewportMode?: ViewportMode;
}): ImportResult {
  const { type, name, guid, parentClass } = options;
  if (type === "DataDefinition" || type === "DataTree") {
    const payload = type === "DataDefinition"
      ? options.dataDefinition ?? createDataDefinitionAsset()
      : options.dataTree ?? createDataTreeAsset(options.defaultDefinitionGuid);
    const result = documentAsset(type, name, guid, { ...payload });
    result.dependencies = assetHeaderDependencies(type, result.payload);
    return result;
  }
  if (type === "RenderTarget") return documentAsset(type, name, guid, { ...createDefaultRenderTargetPayload() });
  if (type === "RenderTargetTexture") return documentAsset(type, name, guid, { ...createDefaultRenderTargetTexturePayload() });
  if (type === "Water") return documentAsset(type, name, guid, createDefaultWaterDefinition() as unknown as Record<string, unknown>);
  if (type === "Prefab") {
    const result = documentAsset(type, name, guid, { components: defaultPrefabComponents(options.viewportMode) });
    result.dependencies = assetHeaderDependencies(type, result.payload);
    return result;
  }

  if (type === "Scene") {
    const payload = createDefaultScene() as unknown as Record<string, unknown>;
    payload.name = name;
    return {
      type: "Scene",
      name,
      guid,
      version: createDefaultMigrationRegistry().currentVersion("Scene"),
      dependencies: [],
      parentClass: null,
      payload,
      chunks: [
        {
          id: DOCUMENT_CHUNK_ID,
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
    };
  }

  if (type === "SceneLayer") {
    const payload = createDefaultSceneLayer() as unknown as Record<
      string,
      unknown
    >;
    payload.name = name;
    return {
      type: "SceneLayer",
      name,
      guid,
      version: createDefaultMigrationRegistry().currentVersion("SceneLayer"),
      dependencies: [],
      parentClass: null,
      payload,
      chunks: [
        {
          id: DOCUMENT_CHUNK_ID,
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
    };
  }

  if (type === "Class") {
    // The class id is the file stem; an engine id would be swallowed by the
    // locked engine class of that name at runtime.
    const classId = classIdForGraphPath(newAssetFileName(type, name));
    if (isLockedEngineClassId(classId)) {
      throw new Error(`"${classId}" is an engine class name. Choose another Class name.`);
    }
    if (walkAncestry(parentClass ?? "Object", options.parentOf ?? engineParentOf).includes("SceneLayer")) {
      throw new Error("SceneLayer classes must be created as Scene Layer assets.");
    }
    const payload = createDefaultLogicGraphSerialized(defaultNodeRegistry, {
      parentClass,
      parentOf: options.parentOf,
      parentGraphs: options.parentGraphs,
    }) as unknown as Record<
      string,
      unknown
    >;
    if (parentClass === "SceneStreamingActor") {
      payload.components = createSceneStreamingActor("prefab").components;
    } else if (parentClass === "RenderTargetCapture") {
      payload.components = [{ id: "prefab-capture", classId: "RenderTargetCaptureComponent", properties: { ...createDefaultRenderTargetCaptureProperties() } }];
    }
    return {
      type: "Class",
      name,
      guid,
      version: 1,
      dependencies: [],
      parentClass: parentClass ?? defaultParentClassForType(type),
      payload,
      chunks: [
        {
          id: DOCUMENT_CHUNK_ID,
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
    };
  }

  if (type === "Sprite") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSpritePayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "SpriteAnimation") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSpriteAnimationPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "AnimationGraph") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultAnimGraph(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "Material") {
    const water = options.waterMaterial === true && (options.materialDomain ?? "surface") === "surface";
    const payload = (water ? createWaterMaterialDocument(name) : createDefaultMaterialDocument(
      name,
      options.materialDomain,
    )) as unknown as Record<string, unknown>;
    return documentAsset(type, name, guid, payload);
  }

  if (type === "MaterialInstance") {
    const payload = createDefaultMaterialInstanceDocument(name) as unknown as Record<string, unknown>;
    return documentAsset(type, name, guid, payload);
  }

  if (type === "MaterialFunction") {
    const payload = createDefaultMaterialFunctionDocument(
      name,
    ) as unknown as Record<string, unknown>;
    return documentAsset(type, name, guid, payload);
  }

  if (type === "Tileset") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultTilesetPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "Tilemap") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultTilemapPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "BehaviourTree") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultBehaviourTree(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "SaveGame") {
    return documentAsset(type, name, guid, { ...createDefaultSaveGameDefinition(guid) });
  }

  if (type === "Blackboard") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultBlackboard(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "Enum" || type === "Structure" || type === "ScriptInterface") {
    const payload: Record<string, unknown> =
      type === "Enum"
        ? { kind: "enum", guid, name, members: [{ name: "None", value: 0 }] }
        : type === "Structure"
          ? { kind: "structure", guid, name, fields: [] }
          : { kind: "scriptInterface", guid, name, methods: [] };
    return {
      type,
      name,
      guid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload,
      chunks: [
        {
          id: DOCUMENT_CHUNK_ID,
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
    };
  }

  if (isInputAssetType(type)) {
    return documentAsset(type, name, guid, createInputAssetPayload(type) as unknown as Record<string, unknown>);
  }

  if (type === "AudioMixer") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultAudioMixerPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "AudioChannel") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultAudioChannelPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "SoundAttenuation") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSoundAttenuationPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "ParticleEmitter") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultParticleEmitterPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "ParticleGraph") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultParticleGraphDocument(name) as unknown as Record<string, unknown>,
    );
  }

  if (type === "ParticleSystem") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultParticleSystemPayload() as unknown as Record<string, unknown>,
    );
  }

  if (type === "SkyboxCreator") {
    return documentAsset(
      type,
      name,
      guid,
      createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>,
    );
  }

  const exhaustive: never = type;
  throw new Error(`Unsupported creatable asset type: ${String(exhaustive)}`);
}

/** A Material Instance of `parent` that inherits its domain and depends on it. */
export function buildMaterialInstanceAssetResult(
  parent: { guid: string; payload?: Record<string, unknown> },
  guid: string,
  name: string,
): ImportResult {
  const document = {
    ...createDefaultMaterialInstanceDocument(name, parent.guid),
    domain: parseMaterialDomain(parent.payload?.domain),
  };
  return {
    ...documentAsset("MaterialInstance", name, guid, document as unknown as Record<string, unknown>),
    dependencies: materialInstanceDependencies(document).all,
  };
}

/** `<Parent>_Instance`, then `<Parent>_Instance_1`, … (the `_N` copy names) until `taken` rejects none. */
export function materialInstanceNameFor(
  parentName: string,
  taken: (name: string) => boolean,
): string {
  const base = `${parentName}_Instance`;
  let name = base;
  for (let index = 1; taken(name); index += 1) name = `${base}_${index}`;
  return name;
}

function documentAsset(
  type: string,
  name: string,
  guid: string,
  payload: Record<string, unknown>,
): ImportResult {
  return {
    type,
    name,
    guid,
    version: createDefaultMigrationRegistry().currentVersion(type) || 1,
    dependencies: [],
    parentClass: null,
    payload,
    chunks: [
      {
        id: DOCUMENT_CHUNK_ID,
        kind: "document",
        mime: "application/json",
        data: new TextEncoder().encode(JSON.stringify(payload)),
      },
    ],
  };
}
