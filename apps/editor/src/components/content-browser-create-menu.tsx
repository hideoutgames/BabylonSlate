import {
  BoxIcon,
  FilmIcon,
  GitBranchIcon,
  Grid3x3Icon,
  ImageIcon,
  ListTreeIcon,
  MapIcon,
  MonitorIcon,
  PackageIcon,
  PaintbrushIcon,
  PaletteIcon,
  SparklesIcon,
  TableIcon,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import {
  newAssetGuid,
  normalizeTilesetPayload,
  type AssetRegistry,
  type ImportResult,
  type IndexedAsset,
} from "@haptic/assets";
import { createDataTreeAsset } from "@haptic/core";
import {
  buildMaterialInstanceAssetResult,
  buildSpriteAnimationAssetResult,
  buildTilesetAssetResult,
  classIdFromClassAsset,
  derivedAssetNameFor,
  isNewAssetNameTaken,
  newAssetFileName,
  parentFolderPath,
  spriteAnimationNameFor,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import {
  ACTOR_SOURCE_TYPES,
  buildModelPrefabAssetResult,
  buildParticleSystemAssetResult,
  buildRenderTargetTextureAssetResult,
  buildSpriteAssetResult,
  buildTextureMaterialAssetResult,
  buildTilemapAssetResult,
  componentsForAssets,
  dataDefinitionFromStructure,
  materialTextureGroups,
} from "../lib/content-browser-create-actions";
import { createProjectAsset, uniqueNewAssetName } from "../lib/create-project-asset";
import { collectClassGraphsForPalette, collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";
import { contentBrowserFolderOps } from "../lib/plugin-ui";
import { asStructureAsset } from "../lib/type-asset-payload";
import { classIdForGraphPath } from "../services/script-compiler";
import type { OpenDocument } from "../services/document-service";

/** What the Create items read from the Content Browser and act through. */
export interface ContentBrowserCreateMenuDeps {
  menuTargetGuidsRef: RefObject<string[]>;
  assetRegistry: AssetRegistry | null;
  browserRoots: Parameters<typeof contentBrowserFolderOps>[1];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setOperationError: (error: string | null) => void;
  noteAssetsCreated: () => void;
  /** Draws the thumbnails of what was created that draw without the Engine (Tilesets). */
  queueCreatedThumbnails: (guids: readonly string[]) => void;
  openOrFocusDocument: (asset: IndexedAsset) => Promise<void>;
  classParentOf: (id: string) => string | null;
  /** Open tabs' unsaved content wins over saved documents (Tilesets, Structures) and Class graphs. */
  getOpenDocuments: () => OpenDocument[];
}

export type ContentBrowserCreateItem = {
  id:
    | "create-material-instance"
    | "create-sprite"
    | "create-sprite-animation"
    | "create-tileset"
    | "create-material"
    | "create-tilemap"
    | "create-prefab"
    | "create-actor"
    | "create-particle-system"
    | "create-child-class"
    | "create-data-definition"
    | "create-data-tree"
    | "create-render-target-texture";
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

/** Selected assets in name order, as the grid lists them (`Run_2` before `Run_10`). */
function byAssetName(a: IndexedAsset, b: IndexedAsset): number {
  return a.header.name.localeCompare(b.header.name, undefined, { numeric: true, sensitivity: "base" });
}

const EMITTER_TYPES: ReadonlySet<string> = new Set(["ParticleEmitter", "ParticleGraph"]);

/**
 * The asset menu's Create items. Each writes beside its source asset (the
 * first selected, in name order), named after it (`_N` when taken), and opens
 * what it made when it made one asset.
 */
export function contentBrowserCreateMenuItems(deps: ContentBrowserCreateMenuDeps): ContentBrowserCreateItem[] {
  const {
    menuTargetGuidsRef,
    assetRegistry,
    browserRoots,
    busy,
    setBusy,
    setOperationError,
    noteAssetsCreated,
    queueCreatedThumbnails,
    openOrFocusDocument,
    classParentOf,
    getOpenDocuments,
  } = deps;

  const targets = (types: ReadonlySet<string> | string): IndexedAsset[] => {
    const accepts = (type: string) => (typeof types === "string" ? type === types : types.has(type));
    return menuTargetGuidsRef.current
      .flatMap((guid) => {
        const asset = assetRegistry?.getByGuid(guid);
        return asset && accepts(asset.header.type) ? [asset] : [];
      })
      .sort(byAssetName);
  };

  /** The folder beside `source`; a read-only root refuses. */
  const besideFolder = (source: IndexedAsset) => {
    const folder = parentFolderPath(source.path);
    const browse = contentBrowserFolderOps(folder, browserRoots);
    if (browse.readOnly) throw new Error(`${browse.pathPrefix} is read-only.`);
    return { folder, browse };
  };

  const freeName = (folder: string, type: CreatableAssetType, base: string, registry: AssetRegistry): string => {
    const assets = registry.list();
    const paths = assets.map((asset) => asset.path);
    if (type === "Class") {
      // Class ids are file stems shared by the whole project.
      const classIds = assets.filter((asset) => asset.header.type === "Class").map((asset) => classIdFromClassAsset(asset));
      return uniqueNewAssetName({ type, preferred: base, folderPath: folder, existingPaths: paths, classIds });
    }
    return derivedAssetNameFor(base, (candidate) => isNewAssetNameTaken(paths, folder, type, candidate));
  };

  /** Writes a built document asset beside `source`. */
  const writeBeside = async (
    registry: AssetRegistry,
    source: IndexedAsset,
    type: CreatableAssetType,
    base: string,
    build: (guid: string, name: string) => ImportResult,
  ): Promise<IndexedAsset> => {
    const { folder, browse } = besideFolder(source);
    const name = freeName(folder, type, base, registry);
    const fileName = newAssetFileName(type, name);
    return registry.createAsset(browse.rootId, browse.relative ? `${browse.relative}/${fileName}` : fileName, build(newAssetGuid(), name));
  };

  /** Writes beside `source` through New Asset's path (Class parent checks, Data validation). */
  const createProjectAssetBeside = (
    registry: AssetRegistry,
    source: IndexedAsset,
    type: CreatableAssetType,
    base: string,
    options: Omit<Parameters<typeof createProjectAsset>[0], "registry" | "rootId" | "folderRelative" | "type" | "name">,
  ): Promise<IndexedAsset> => {
    const { folder, browse } = besideFolder(source);
    return createProjectAsset({
      registry,
      rootId: browse.rootId,
      folderRelative: browse.relative,
      type,
      name: freeName(folder, type, base, registry),
      ...options,
    });
  };

  const openContent = (asset: IndexedAsset): unknown =>
    getOpenDocuments().find((doc) => doc.ref.path === asset.path)?.content;

  /** An open tab's unsaved content, else the saved document. */
  const documentPayload = async (registry: AssetRegistry, asset: IndexedAsset): Promise<Record<string, unknown>> => {
    const open = openContent(asset);
    if (open && typeof open === "object") return open as Record<string, unknown>;
    return (await registry.readAssetDocument(asset.header.guid)).payload;
  };

  const classGraphs = (registry: AssetRegistry) =>
    collectClassGraphsForPalette({ assets: registry.list(), openDocuments: getOpenDocuments(), classIdForPath: classIdForGraphPath });
  const typeSchemas = (registry: AssetRegistry) =>
    typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets: registry.list(), openDocuments: getOpenDocuments() }));

  /** Runs one Create: busy while it writes, reports a failure, and opens the result when there is one. */
  const run = (work: (registry: AssetRegistry) => Promise<IndexedAsset[]>) => {
    if (busy || !assetRegistry) return;
    const registry = assetRegistry;
    void (async () => {
      setBusy(true);
      setOperationError(null);
      const created: IndexedAsset[] = [];
      try {
        created.push(...(await work(registry)));
        if (created.length === 1) await openOrFocusDocument(created[0]!);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
      } finally {
        // The mounted registry indexed each new asset on write: no rescan.
        if (created.length > 0) {
          noteAssetsCreated();
          queueCreatedThumbnails(created.map((asset) => asset.header.guid));
        }
        setBusy(false);
      }
    })();
  };

  return [
    {
      id: "create-material-instance",
      label: "Create Instance",
      icon: <PaintbrushIcon />,
      onSelect: () => run(async (registry) => {
        const parent = registry.getByGuid(menuTargetGuidsRef.current[0] ?? "");
        if (!parent) return [];
        // Beside its parent, so a Material and its instances stay together.
        return [await writeBeside(registry, parent, "MaterialInstance", `${parent.header.name}_Instance`, (guid, name) =>
          buildMaterialInstanceAssetResult(parent.header, guid, name))];
      }),
    },
    {
      id: "create-sprite",
      label: "Create Sprite",
      icon: <ImageIcon />,
      onSelect: () => run(async (registry) => {
        // One Sprite per Texture, each beside its Texture.
        const created: IndexedAsset[] = [];
        for (const texture of targets("Texture")) {
          created.push(await writeBeside(registry, texture, "Sprite", texture.header.name, (guid, name) =>
            buildSpriteAssetResult(texture.header.guid, guid, name)));
        }
        return created;
      }),
    },
    {
      id: "create-sprite-animation",
      label: "Create Sprite Animation",
      icon: <FilmIcon />,
      onSelect: () => run(async (registry) => {
        const sources = targets(new Set(["Texture", "Sprite"]));
        const first = sources[0];
        if (!first) return [];
        // One frame per Texture or Sprite, in name order, beside the first.
        return [await writeBeside(registry, first, "SpriteAnimation", spriteAnimationNameFor(first.header.name), (guid, name) =>
          buildSpriteAnimationAssetResult(sources.map((asset) => ({ guid: asset.header.guid, type: asset.header.type })), guid, name))];
      }),
    },
    {
      id: "create-tileset",
      label: "Create Tileset",
      icon: <Grid3x3Icon />,
      onSelect: () => run(async (registry) => {
        const texture = targets("Texture")[0];
        if (!texture) return [];
        return [await writeBeside(registry, texture, "Tileset", texture.header.name, (guid, name) =>
          buildTilesetAssetResult({ guid: texture.header.guid, payload: texture.header.payload }, guid, name))];
      }),
    },
    {
      id: "create-material",
      label: "Create Material",
      icon: <PaletteIcon />,
      onSelect: () => run(async (registry) => {
        // Textures sharing a name before a map suffix make one Material.
        const textures = targets("Texture");
        const created: IndexedAsset[] = [];
        for (const group of materialTextureGroups(textures.map((asset) => ({ guid: asset.header.guid, name: asset.header.name })))) {
          const source = textures.find((asset) => asset.header.guid === group.firstGuid)!;
          created.push(await writeBeside(registry, source, "Material", group.name, (guid, name) =>
            buildTextureMaterialAssetResult(group, guid, name)));
        }
        return created;
      }),
    },
    {
      id: "create-tilemap",
      label: "Create Tilemap",
      icon: <MapIcon />,
      onSelect: () => run(async (registry) => {
        const tilesets = targets("Tileset");
        const first = tilesets[0];
        if (!first) return [];
        const payloads = await Promise.all(tilesets.map(async (asset) => ({
          guid: asset.header.guid,
          payload: normalizeTilesetPayload(await documentPayload(registry, asset)),
        })));
        return [await writeBeside(registry, first, "Tilemap", first.header.name, (guid, name) =>
          buildTilemapAssetResult(payloads, guid, name))];
      }),
    },
    {
      id: "create-prefab",
      label: "Create Prefab",
      icon: <PackageIcon />,
      onSelect: () => run(async (registry) => {
        const models = targets("Model");
        const first = models[0];
        if (!first) return [];
        // One Prefab holding every selected Model.
        return [await writeBeside(registry, first, "Prefab", first.header.name, (guid, name) =>
          buildModelPrefabAssetResult(models.map((asset) => asset.header.guid), guid, name))];
      }),
    },
    {
      id: "create-actor",
      label: "Create Actor",
      icon: <BoxIcon />,
      onSelect: () => run(async (registry) => {
        const sources = targets(ACTOR_SOURCE_TYPES);
        const first = sources[0];
        if (!first) return [];
        // One Actor Class with a component per selected asset.
        return [await createProjectAssetBeside(registry, first, "Class", first.header.name, {
          parentClass: "Actor",
          classComponents: componentsForAssets(sources.map((asset) => ({ guid: asset.header.guid, type: asset.header.type })), "actor"),
          classParentOf,
          parentGraphs: classGraphs(registry),
        })];
      }),
    },
    {
      id: "create-particle-system",
      label: "Create Particle System",
      icon: <SparklesIcon />,
      onSelect: () => run(async (registry) => {
        const emitters = targets(EMITTER_TYPES);
        const first = emitters[0];
        if (!first) return [];
        return [await writeBeside(registry, first, "ParticleSystem", first.header.name, (guid, name) =>
          buildParticleSystemAssetResult(emitters.map((asset) => asset.header.guid), guid, name))];
      }),
    },
    {
      id: "create-child-class",
      label: "Create Child Class",
      icon: <GitBranchIcon />,
      onSelect: () => run(async (registry) => {
        const parent = targets("Class")[0];
        if (!parent) return [];
        return [await createProjectAssetBeside(registry, parent, "Class", `${parent.header.name}_Child`, {
          parentClass: classIdFromClassAsset(parent),
          classParentOf,
          parentGraphs: classGraphs(registry),
        })];
      }),
    },
    {
      id: "create-data-definition",
      label: "Create Data Definition",
      icon: <TableIcon />,
      onSelect: () => run(async (registry) => {
        const structure = targets("Structure")[0];
        if (!structure) return [];
        const dataDefinition = dataDefinitionFromStructure(asStructureAsset(await documentPayload(registry, structure)));
        return [await createProjectAssetBeside(registry, structure, "DataDefinition", structure.header.name, {
          dataDefinition,
          typeSchemas: typeSchemas(registry),
        })];
      }),
    },
    {
      id: "create-data-tree",
      label: "Create Data Tree",
      icon: <ListTreeIcon />,
      onSelect: () => run(async (registry) => {
        const definition = targets("DataDefinition")[0];
        if (!definition) return [];
        const guid = definition.header.guid;
        return [await createProjectAssetBeside(registry, definition, "DataTree", definition.header.name, {
          defaultDefinitionGuid: guid,
          dataTree: createDataTreeAsset(guid),
          typeSchemas: typeSchemas(registry),
        })];
      }),
    },
    {
      id: "create-render-target-texture",
      label: "Create Render Target Texture",
      icon: <MonitorIcon />,
      onSelect: () => run(async (registry) => {
        const target = targets("RenderTarget")[0];
        if (!target) return [];
        return [await writeBeside(registry, target, "RenderTargetTexture", target.header.name, (guid, name) =>
          buildRenderTargetTextureAssetResult(target.header.guid, guid, name))];
      }),
    },
  ];
}
