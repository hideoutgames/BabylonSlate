import type { AssetRegistry, FolderNode } from "@babylonslate/assets";
import type { ProjectSettings, RuntimeAssetCatalogEntry } from "@babylonslate/core";
import { collectHeaderReachability, runtimeAssetCatalogFromIndexed } from "@babylonslate/exporter";
import { RuntimeAssetCatalog } from "@babylonslate/runtime";
import { classParentLookup } from "../lib/content-browser-helpers";
import { assetsFromIndexed, exportRootSettings } from "./export-game";

type CatalogRegistry = Pick<AssetRegistry, "list" | "listRoots">;

/** Registry entries that are real assets, not the placeholder kept for a missing guid. */
function authoredAssets(registry: CatalogRegistry) {
  return registry.list().filter((asset) => !asset.placeholder);
}

/**
 * The assets Editor Play lists to Asset Registry nodes: what a game exported
 * from the same settings would ship, plus the Scene Play starts from. Computed
 * from headers when Play starts, so it is a snapshot of that moment.
 */
export function playAssetCatalog(options: {
  registry: CatalogRegistry;
  settings: ProjectSettings;
  /** The Scene Play starts from. */
  sceneGuid: string;
}): RuntimeAssetCatalogEntry[] {
  const { registry, settings } = options;
  const assets = authoredAssets(registry);
  const indexed = assetsFromIndexed(assets);
  const packaged = collectHeaderReachability({
    startupSceneGuid: settings.startupSceneGuid,
    extraSceneGuids: [options.sceneGuid],
    ...exportRootSettings({
      saveGameDefinitionGuid: settings.saveGame.definitionGuid,
      defaultFontGuid: settings.fonts.defaultFontGuid,
      gameInstanceClass: settings.gameInstanceClass,
      audioMixerGuid: settings.audio.audioMixerGuid,
      renderSettings: settings.render,
      alwaysPackageFolders: settings.alwaysPackageFolders,
    }),
    assets: indexed,
    // The registry mounts exactly the enabled plugins.
    pluginEnabledGuids: new Set(
      registry.listRoots().flatMap((root) => (root.id.startsWith("plugin:") ? [root.id.slice("plugin:".length)] : [])),
    ),
    parentOf: classParentLookup(assets),
  });
  return packaged.ok ? runtimeAssetCatalogFromIndexed(indexed, new Set(packaged.value.guids)) : [];
}

function folderPaths(node: FolderNode): string[] {
  return [node.path, ...node.children.flatMap(folderPaths)];
}

/**
 * The catalog editor graph hosts query: every asset of every mounted root,
 * including editor-only assets, and the registry's empty folders. It is rebuilt
 * on first use after the registry's generation changes.
 */
export function createRegistryCatalogSource(
  getRegistry: () => (CatalogRegistry & Pick<AssetRegistry, "generation" | "folderTree">) | null | undefined,
): () => RuntimeAssetCatalog | null {
  let cached: { registry: object; generation: number; catalog: RuntimeAssetCatalog } | null = null;
  return () => {
    const registry = getRegistry();
    if (!registry) return null;
    if (cached?.registry === registry && cached.generation === registry.generation) return cached.catalog;
    const catalog = new RuntimeAssetCatalog(
      runtimeAssetCatalogFromIndexed(assetsFromIndexed(authoredAssets(registry))),
      { folders: registry.listRoots().flatMap((root) => folderPaths(registry.folderTree(root.id))) },
    );
    cached = { registry, generation: registry.generation, catalog };
    return catalog;
  };
}
