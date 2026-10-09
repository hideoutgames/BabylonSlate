import {
  newAssetGuid,
  type AssetRegistry,
  type ImportResult,
  type IndexedAsset,
} from "@babylonslate/assets";
import {
  createActor,
  createMeshComponent,
  createText3DComponent,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  type DocumentKind,
  type ProjectSettings,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
  type SerializedSceneLayer,
  type SerializedTransform,
  type SkyboxFaces,
} from "@babylonslate/core";
import type { NavMeshGenerateInput } from "@babylonslate/navigation";
import { isLockedEngineClassId } from "@babylonslate/object-model";
import { defaultComponentAuthoringProperties } from "@babylonslate/runtime";
import {
  buildNewAssetResult,
  newAssetFileName,
  type CreatableAssetType,
} from "../content-browser-helpers";
import { withDocumentPayload } from "../scaffold-empty-3d";
import { classIdForGraphPath } from "../../services/script-compiler";
import type { FeatureTestHolidayModel } from "./engine-content-files";
import {
  FEATURE_TEST_ZONES,
  zonePoint,
  type FeatureTestZoneId,
} from "./layout";

export type Vec3 = [number, number, number];
type SavedKind = Exclude<DocumentKind, "content-browser">;

/** Root of every FeatureTest asset, relative to the project `assets/` folder. */
export const FEATURE_TEST_ROOT = "FeatureTest";

/** ProjectService capabilities the scaffold writes through. */
export interface FeatureTestHost {
  readonly registry: AssetRegistry;
  saveDocument(
    kind: SavedKind,
    path: string,
    content: SerializedScene | SerializedSceneLayer | SerializedGraph | Record<string, unknown>,
    options?: { parentClass?: string | null },
  ): Promise<void>;
  loadDocument(kind: SavedKind, path: string): Promise<unknown>;
  /** Allocate (or read) the guid a not-yet-saved storage path will be written with. */
  guidForAsset(path: string): Promise<string>;
  writeSceneNavmeshChunk(path: string, bytes: Uint8Array, payload: Record<string, unknown>): Promise<void>;
  /** Required repository content (`engine-content/...`). Throws when missing. */
  loadBytes(path: string): Promise<Uint8Array>;
  /** First present optional CC0 slot file, or null. */
  loadOptional(candidates: readonly string[]): Promise<{ path: string; bytes: Uint8Array } | null>;
  generateNavMesh(input: NavMeshGenerateInput): Promise<Uint8Array>;
  /** Pinned so the workload does not follow the user's Engine Settings import scale. */
  readonly modelImportScale: number;
}

export type FeatureTestMaterialKey =
  /** Lit PBR surface sampling the colormap, tinted by a Material Function, with parameters. */
  | "surface"
  /** Material Instance of `surface` with parameter overrides. */
  | "surfaceInstance"
  /** Time-animated emissive surface. */
  | "emissive"
  /** Alpha-blended surface. */
  | "translucent"
  /** Particle domain, alpha blended. */
  | "particle"
  /** Particle domain, additive. */
  | "particleAdditive"
  /** Post-process domain. */
  | "postProcess"
  /** Landscape domain with paint layers. */
  | "landscape"
  /** Unlit surface for overlays (2D Material widget, sprites). */
  | "overlayUnlit";

export interface FeatureTestClassRef {
  path: string;
  classId: string;
  guid: string;
  parentClass: string;
}

/** Cross-area references. Each area fills its own fields; later areas read them. */
export interface FeatureTestAssets {
  textures: {
    /** Holiday Pack colormap imported as a compressed albedo Texture (KTX2 encode path). */
    colormap: string;
    /** Same pixels with `pixelArt` usage for Sprites, Tilesets and Sprite Animations. */
    colormapPixelArt: string;
    /** Engine billboard PNGs imported with `ui` usage, keyed by file stem (`camera`, `audio`, ...). */
    ui: Record<string, string>;
    /** Six uncompressed `skybox` usage face Textures. */
    skyFaces: SkyboxFaces;
    /** Cubemap net source for the Skybox Creator. */
    skyboxNet: string;
    /** User-supplied CC0 LUT strip, or null when the slot is empty. */
    colorGradingLut: string | null;
  };
  /** Holiday Pack Model guids by file stem. */
  models: Record<FeatureTestHolidayModel, string>;
  /** Rigid node Animation guids imported with `cabin-door-rotate`, keyed by clip name. */
  doorAnimations: Record<string, string>;
  /** Basic 3D Mannequin import (Model, hierarchy Skeleton, 27 clips, idle Anim Graph, Class). */
  mannequin: {
    modelGuid: string;
    skeletonGuid: string;
    /** Animation guids keyed by clip name. */
    animations: Record<string, string>;
    idleGraphGuid: string;
    classId: string;
    classPath: string;
    /** The Basic 3D Mannequin actor kept at the hub. */
    actorId: string;
  };
  fonts: {
    /** Facetype Font built from the engine's bundled ASCII glyph outlines. */
    facetype: string;
    /** Geist source Font (OFL). */
    geist: string;
  };
  /** User-supplied CC0 Audio assets (null when the slot is empty). Filled by the audio area. */
  audio: {
    loop: string | null;
    oneShot: string | null;
    mixer: string | null;
    channel: string | null;
    attenuation: string | null;
  };
  materials: Partial<Record<FeatureTestMaterialKey, string>>;
  /** Every FeatureTest Class keyed by class id. */
  classes: Record<string, FeatureTestClassRef>;
}

export type SceneDocumentKind = "scene" | "scene-layer";

interface PendingSceneDocument {
  kind: SceneDocumentKind;
  path: string;
  guid: string;
  content: SerializedScene | SerializedSceneLayer;
  /** Lower saves first; referenced documents must save before their referrers. */
  order: number;
}

/** Save order for extra scene documents (the main scene always saves last). */
export const SCENE_SAVE_ORDER = { sceneLayer: 10, subScene: 20, scene: 30 } as const;

export interface FeatureTestContext {
  readonly host: FeatureTestHost;
  readonly registry: AssetRegistry;
  /** `assets/main.scene.babasset`, mutated in memory and saved last. */
  readonly mainScene: SerializedScene;
  readonly mainScenePath: string;
  /**
   * `FeatureTest/Scenes/FT_Stress` heavy workload scene (camera, sky, sun and
   * a large floor already present). Place actors with `stressPoint` regions.
   */
  readonly stressScene: SerializedScene;
  readonly assets: FeatureTestAssets;
  /** Applied in order to the project settings after every asset exists. */
  readonly settingsPatches: Array<(settings: ProjectSettings) => ProjectSettings>;
  /** Extra scene / scene layer documents saved before the main scene. */
  readonly sceneDocuments: PendingSceneDocument[];
  /** Storage path (`assets/FeatureTest/<folder>/<file>`). */
  storagePath(folder: string, fileName: string): string;
  /** New creatable asset from `buildNewAssetResult`, optionally with a replaced payload. */
  createAsset(
    type: CreatableAssetType,
    folder: string,
    name: string,
    options?: {
      payload?: Record<string, unknown> | ((payload: Record<string, unknown>) => Record<string, unknown>);
      parentClass?: string | null;
      build?: Partial<Parameters<typeof buildNewAssetResult>[0]>;
      dependencies?: string[];
    },
  ): Promise<{ guid: string; path: string; asset: IndexedAsset }>;
  /** Write a prepared ImportResult under `FeatureTest/<folder>/<fileName>`. */
  createImportResult(folder: string, fileName: string, result: ImportResult): Promise<IndexedAsset>;
  /** Import a source file (PNG, GLB, font, audio) under `FeatureTest/<folder>`. */
  importFile(
    folder: string,
    fileName: string,
    bytes: Uint8Array,
    extras?: Parameters<AssetRegistry["importFile"]>[4],
  ): Promise<IndexedAsset[]>;
  /** Save a document through ProjectService (header metadata, normalizers, dependencies). */
  saveDocument(
    kind: SavedKind,
    folder: string,
    fileName: string,
    content: SerializedGraph | Record<string, unknown>,
    options?: { parentClass?: string | null },
  ): Promise<{ guid: string; path: string }>;
  /** Save a Class (`<name>.class.babasset`); the class id is the file stem. */
  saveClass(options: {
    folder: string;
    name: string;
    parentClass: string;
    graph: SerializedGraph;
  }): Promise<FeatureTestClassRef>;
  /** Reserve a scene document saved at finalization; returns its guid now. */
  addSceneDocument(options: {
    kind: SceneDocumentKind;
    folder: string;
    name: string;
    content: SerializedScene | SerializedSceneLayer;
    order: number;
  }): Promise<{ guid: string; path: string }>;
  /** Zone helpers: label, Outliner folder and world positions. */
  zone(id: FeatureTestZoneId): FeatureTestZoneHandle;
  /** Add an actor to a scene (main scene by default); rejects duplicate actor or component ids. */
  addActor(actor: SerializedActor, options?: { zone?: FeatureTestZoneId; scene?: SerializedScene }): SerializedActor;
  /** Queue a project settings change. */
  patchSettings(patch: (settings: ProjectSettings) => ProjectSettings): void;
}

export interface FeatureTestZoneHandle {
  readonly id: FeatureTestZoneId;
  readonly folderId: string;
  /** World position from a zone-local offset. */
  at(x: number, y: number, z: number): Vec3;
  /** Static floor slab covering the zone (top face at y = 0, simple collision). */
  floor(options?: { id?: string; materialGuid?: string | null; size?: readonly [number, number] }): SerializedActor;
}

/** Transform helper: position, Euler degrees (pitch, yaw, roll) and scale. */
export function tf(
  position: Vec3 = [0, 0, 0],
  options: { rotationDeg?: Vec3; rotation?: [number, number, number, number]; scale?: Vec3 } = {},
): SerializedTransform {
  return {
    position,
    rotation: options.rotation ?? (options.rotationDeg ? eulerDegreesToQuaternion(options.rotationDeg) : [0, 0, 0, 1]),
    scale: options.scale ?? [1, 1, 1],
  };
}

/** Engine component with the editor's Add Component defaults plus overrides. */
export function comp(
  id: string,
  classId: string,
  overrides: Record<string, unknown> = {},
  transform: SerializedTransform = identitySerializedTransform(),
  options: { physicsWorld?: "2d" | "3d"; parentId?: string | null; name?: string } = {},
): SerializedComponent {
  const world = options.physicsWorld ?? "3d";
  return {
    id,
    classId,
    ...(options.name ? { name: options.name } : {}),
    properties: { ...defaultComponentAuthoringProperties(classId, world, world), ...overrides },
    parentId: options.parentId ?? null,
    transform,
  };
}

/** Primitive mesh (box 1.5 m, sphere Ø1.5, cylinder 1.5 × Ø1, plane 1.5, ground 10 × 10). */
export function meshComp(
  id: string,
  kind: "box" | "sphere" | "cylinder" | "plane" | "ground",
  options: { collision?: "none" | "simple" | "complex"; materialGuid?: string | null; assetGuid?: string | null } = {},
): SerializedComponent {
  const mesh = createMeshComponent(id, kind, options.collision ?? "none");
  if (options.materialGuid) mesh.properties.materialGuid = options.materialGuid;
  if (options.assetGuid) mesh.properties.assetGuid = options.assetGuid;
  return mesh;
}

/** Actor with explicit transform and components. */
export function actor(
  id: string,
  name: string,
  transform: SerializedTransform,
  components: SerializedComponent[],
  overrides: Partial<Omit<SerializedActor, "id" | "name" | "transform" | "components">> = {},
): SerializedActor {
  return createActor(id, name, { ...overrides, transform, components });
}

const PRIMITIVE_BOX_SIZE = 1.5;
const FLOOR_THICKNESS = 0.3;

function emptyAssets(): FeatureTestAssets {
  return {
    textures: {
      colormap: "",
      colormapPixelArt: "",
      ui: {},
      skyFaces: { px: null, nx: null, py: null, ny: null, pz: null, nz: null },
      skyboxNet: "",
      colorGradingLut: null,
    },
    models: {} as Record<FeatureTestHolidayModel, string>,
    doorAnimations: {},
    mannequin: {
      modelGuid: "",
      skeletonGuid: "",
      animations: {},
      idleGraphGuid: "",
      classId: "",
      classPath: "",
      actorId: "",
    },
    fonts: { facetype: "", geist: "" },
    audio: { loop: null, oneShot: null, mixer: null, channel: null, attenuation: null },
    materials: {},
    classes: {},
  };
}

/** Throws when a cross-area reference was not created by an earlier area. */
export function requireRef(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`FeatureTest is missing ${label}; check the scaffold area order.`);
  return value;
}

export function createFeatureTestContext(options: {
  host: FeatureTestHost;
  mainScene: SerializedScene;
  mainScenePath: string;
  stressScene: SerializedScene;
}): FeatureTestContext {
  const { host, mainScene, stressScene } = options;
  const registry = host.registry;
  const assets = emptyAssets();
  const settingsPatches: FeatureTestContext["settingsPatches"] = [];
  const sceneDocuments: PendingSceneDocument[] = [];
  const zones = new Map<FeatureTestZoneId, FeatureTestZoneHandle>();
  const rootPath = (folder: string, fileName: string) =>
    [FEATURE_TEST_ROOT, folder, fileName].filter(Boolean).join("/");
  const storagePath = (folder: string, fileName: string) => `assets/${rootPath(folder, fileName)}`;

  const addActor: FeatureTestContext["addActor"] = (next, addOptions = {}) => {
    const scene = addOptions.scene ?? mainScene;
    if (scene.actors.some((existing) => existing.id === next.id)) {
      throw new Error(`FeatureTest actor id "${next.id}" is already used.`);
    }
    const componentIds = new Set<string>();
    for (const component of next.components) {
      if (componentIds.has(component.id)) {
        throw new Error(`FeatureTest actor "${next.id}" repeats component id "${component.id}".`);
      }
      componentIds.add(component.id);
    }
    if (addOptions.zone && next.folderId === null && scene === mainScene) {
      next.folderId = zone(addOptions.zone).folderId;
    }
    scene.actors.push(next);
    return next;
  };

  const zone = (id: FeatureTestZoneId): FeatureTestZoneHandle => {
    const existing = zones.get(id);
    if (existing) return existing;
    const spec = FEATURE_TEST_ZONES[id];
    const folderId = `ft-folder-${id}`;
    mainScene.folders.push({ id: folderId, name: spec.title, parentFolderId: null });
    const handle: FeatureTestZoneHandle = {
      id,
      folderId,
      at: (x, y, z) => zonePoint(id, [x, y, z]),
      floor: (floorOptions = {}) => {
        const [width, depth] = floorOptions.size ?? spec.size;
        const mesh = meshComp(`${floorOptions.id ?? `ft-${id}-floor`}-mesh`, "box", {
          collision: "simple",
          materialGuid: floorOptions.materialGuid ?? null,
        });
        return addActor(
          actor(
            floorOptions.id ?? `ft-${id}-floor`,
            `${spec.title} Floor`,
            tf(zonePoint(id, [0, -FLOOR_THICKNESS / 2, 0]), {
              scale: [width / PRIMITIVE_BOX_SIZE, FLOOR_THICKNESS / PRIMITIVE_BOX_SIZE, depth / PRIMITIVE_BOX_SIZE],
            }),
            [mesh],
          ),
          { zone: id },
        );
      },
    };
    zones.set(id, handle);
    // Title label over the back edge of the zone, readable from the main camera.
    const label = createText3DComponent(`ft-${id}-label-text`);
    Object.assign(label.properties, {
      text: spec.title,
      size: id === "hub" ? 1.6 : 1.1,
      color: [1, 0.86, 0.42],
      alignment: "center",
      fontAssetGuid: assets.fonts.facetype || null,
    });
    addActor(
      actor(`ft-${id}-label`, `${spec.title} Label`, tf(zonePoint(id, [0, 5, spec.size[1] / 2 - 1])), [label]),
      { zone: id },
    );
    return handle;
  };

  const createImportResult: FeatureTestContext["createImportResult"] = (folder, fileName, result) =>
    registry.createAsset("project", rootPath(folder, fileName), result);

  return {
    host,
    registry,
    mainScene,
    mainScenePath: options.mainScenePath,
    stressScene,
    assets,
    settingsPatches,
    sceneDocuments,
    storagePath,
    async createAsset(type, folder, name, createOptions = {}) {
      const guid = newAssetGuid();
      const base = buildNewAssetResult({
        ...createOptions.build,
        type,
        name,
        guid,
        parentClass: createOptions.parentClass ?? createOptions.build?.parentClass ?? null,
      });
      const replaced = typeof createOptions.payload === "function"
        ? createOptions.payload(structuredClone(base.payload))
        : createOptions.payload;
      const result = replaced ? withDocumentPayload(base, replaced) : base;
      if (createOptions.dependencies) result.dependencies = createOptions.dependencies;
      const fileName = newAssetFileName(type, name);
      const asset = await createImportResult(folder, fileName, result);
      return { guid: asset.header.guid, path: asset.path, asset };
    },
    createImportResult,
    importFile: (folder, fileName, bytes, extras) =>
      registry.importFile("project", rootPath(folder, ""), fileName, bytes, extras),
    async saveDocument(kind, folder, fileName, content, saveOptions) {
      const path = storagePath(folder, fileName);
      const guid = await host.guidForAsset(path);
      await host.saveDocument(kind, path, content, saveOptions);
      return { guid, path };
    },
    async saveClass({ folder, name, parentClass, graph }) {
      const fileName = newAssetFileName("Class", name);
      const path = storagePath(folder, fileName);
      const classId = classIdForGraphPath(path);
      if (isLockedEngineClassId(classId)) {
        throw new Error(`FeatureTest Class "${classId}" collides with an engine class id.`);
      }
      if (assets.classes[classId]) throw new Error(`FeatureTest Class "${classId}" already exists.`);
      const guid = await host.guidForAsset(path);
      await host.saveDocument("graph", path, graph, { parentClass });
      const ref = { path, classId, guid, parentClass };
      assets.classes[classId] = ref;
      return ref;
    },
    async addSceneDocument({ kind, folder, name, content, order }) {
      const suffix = kind === "scene" ? ".scene.babasset" : ".scenelayer.babasset";
      const path = storagePath(folder, `${name}${suffix}`);
      if (sceneDocuments.some((entry) => entry.path === path)) {
        throw new Error(`FeatureTest scene document "${path}" already exists.`);
      }
      const guid = await host.guidForAsset(path);
      sceneDocuments.push({ kind, path, guid, content, order });
      return { guid, path };
    },
    zone,
    addActor,
    patchSettings(patch) {
      settingsPatches.push(patch);
    },
  };
}
