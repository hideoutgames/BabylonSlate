import {
  ENGINE_ASSET_DATA_STRUCT_ID,
  ENGINE_ASSET_FILTER_STRUCT_ID,
  ENGINE_ASSET_TYPE_ENUM_ID,
  BOOL,
  STRING,
  arrayOf,
  assetRef,
  classRef,
  enumRef,
  pin,
  structRef,
  type NodeDefinition,
} from "@babylonslate/scripting";
import { castDefaultClassId } from "./casting";

/** Asset Registry queries answer from the packaged asset catalog of the running host. */
export const ASSET_REGISTRY_BY_CLASS_NODE_ID = "assetRegistry.getAssetsByClass";

const ASSET_DATA = structRef(ENGINE_ASSET_DATA_STRUCT_ID);
const ASSET_FILTER = structRef(ENGINE_ASSET_FILTER_STRUCT_ID);
const ASSET_TYPE = enumRef(ENGINE_ASSET_TYPE_ENUM_ID);
const ANY_ASSET = assetRef("");

const folderPin = () => pin("folder", "Folder", "in", STRING, "data", true, "");
const recursivePin = (value: boolean) => pin("recursive", "Recursive", "in", BOOL, "data", true, value);
const assetsPin = () => pin("assets", "Assets", "out", arrayOf(ASSET_DATA));

export const assetRegistryNodes: NodeDefinition[] = [
  {
    id: "assetRegistry.getAssetData",
    title: "Get Asset Data",
    category: "assetRegistry",
    pure: true,
    description:
      "Looks up an asset in the packaged asset catalog. Found is false, and Asset Data empty, when the catalog does not hold it.",
    pins: () => [
      pin("asset", "Asset", "in", ANY_ASSET),
      pin("assetData", "Asset Data", "out", ASSET_DATA),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => ({
      assetData: `ctx.assetRegistry.getAssetData(${ctx.input("asset")})`,
      found: `ctx.assetRegistry.hasAsset(${ctx.input("asset")})`,
    }),
  },
  {
    id: "assetRegistry.getAssetByPath",
    title: "Get Asset By Path",
    category: "assetRegistry",
    pure: true,
    description:
      "Looks up an asset by its full storage path, such as assets/Weapons/Rifle.class.babasset. Found is false when no packaged asset has that path.",
    pins: () => [
      pin("path", "Path", "in", STRING),
      pin("assetData", "Asset Data", "out", ASSET_DATA),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => ({
      assetData: `ctx.assetRegistry.getAssetByPath(${ctx.input("path")})`,
      found: `ctx.assetRegistry.hasAssetPath(${ctx.input("path")})`,
    }),
  },
  {
    id: "assetRegistry.getAssetsByPath",
    title: "Get Assets By Path",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the assets in a folder, sorted by path. Recursive includes subfolders. An empty folder with Recursive lists everything.",
    pins: () => [folderPin(), recursivePin(false), assetsPin()],
    codegen: (ctx) => ({
      assets: `ctx.assetRegistry.getAssetsByPath(${ctx.input("folder")}, ${ctx.input("recursive")})`,
    }),
  },
  {
    id: "assetRegistry.getAssetsByType",
    title: "Get Assets By Type",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the assets of one type, sorted by path. Folder limits the search; empty searches every folder.",
    pins: () => [
      pin("type", "Type", "in", ASSET_TYPE),
      folderPin(),
      recursivePin(true),
      assetsPin(),
    ],
    codegen: (ctx) => ({
      assets: `ctx.assetRegistry.getAssetsByType(${ctx.input("type")}, ${ctx.input("folder")}, ${ctx.input("recursive")})`,
    }),
  },
  {
    id: ASSET_REGISTRY_BY_CLASS_NODE_ID,
    title: "Get Assets By Class",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the Class assets of a Class, and with Include Subclasses the Classes that inherit from it, without loading them. Classes holds their Class values, typed as the selected Class so a Class that inherits from Actor can feed Spawn Actor.",
    pins: (properties) => [
      pin("class", "Class", "in", classRef("BObject")),
      pin("includeSubclasses", "Include Subclasses", "in", BOOL, "data", true, true),
      folderPin(),
      recursivePin(true),
      assetsPin(),
      pin("classes", "Classes", "out", arrayOf(classRef(castDefaultClassId(properties)))),
    ],
    codegen: (ctx) => {
      const query = `ctx.assetRegistry.getAssetsByClass(${ctx.input("class")}, ${ctx.input("includeSubclasses")}, ${ctx.input("folder")}, ${ctx.input("recursive")})`;
      return { assets: query, classes: `${query}.map((asset) => asset.Class)` };
    },
  },
  {
    id: "assetRegistry.findAssets",
    title: "Find Assets",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the assets matching every part of the filter: folders, types, Classes, and a name fragment (not case sensitive). An empty part does not constrain the search.",
    searchAliases: ["search assets", "query assets"],
    pins: () => [pin("filter", "Filter", "in", ASSET_FILTER), assetsPin()],
    codegen: (ctx) => ({ assets: `ctx.assetRegistry.findAssets(${ctx.input("filter")})` }),
  },
  {
    id: "assetRegistry.getSubFolders",
    title: "Get Sub Folders",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the full paths of the folders below a folder. Exported games know only the folders of packaged assets.",
    pins: () => [
      folderPin(),
      recursivePin(false),
      pin("folders", "Folders", "out", arrayOf(STRING)),
    ],
    codegen: (ctx) => ({
      folders: `ctx.assetRegistry.getSubFolders(${ctx.input("folder")}, ${ctx.input("recursive")})`,
    }),
  },
  {
    id: "assetRegistry.folderHasAssets",
    title: "Folder Has Assets",
    category: "assetRegistry",
    pure: true,
    description: "True when the folder holds at least one packaged asset.",
    pins: () => [folderPin(), recursivePin(true), pin("hasAssets", "Has Assets", "out", BOOL)],
    codegen: (ctx) => ({
      hasAssets: `ctx.assetRegistry.folderHasAssets(${ctx.input("folder")}, ${ctx.input("recursive")})`,
    }),
  },
  {
    id: "assetRegistry.getDependencies",
    title: "Get Asset Dependencies",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the catalog assets this asset references, sorted by path. Hard Only keeps the references that load with it.",
    pins: () => [
      pin("asset", "Asset", "in", ANY_ASSET),
      pin("hardOnly", "Hard Only", "in", BOOL, "data", true, false),
      pin("assets", "Assets", "out", arrayOf(ANY_ASSET)),
    ],
    codegen: (ctx) => ({
      assets: `ctx.assetRegistry.getDependencies(${ctx.input("asset")}, ${ctx.input("hardOnly")})`,
    }),
  },
  {
    id: "assetRegistry.getReferencers",
    title: "Get Asset Referencers",
    category: "assetRegistry",
    pure: true,
    description:
      "Lists the catalog assets that reference this asset, sorted by path. Hard Only keeps the references that load with their owner.",
    pins: () => [
      pin("asset", "Asset", "in", ANY_ASSET),
      pin("hardOnly", "Hard Only", "in", BOOL, "data", true, false),
      pin("assets", "Assets", "out", arrayOf(ANY_ASSET)),
    ],
    codegen: (ctx) => ({
      assets: `ctx.assetRegistry.getReferencers(${ctx.input("asset")}, ${ctx.input("hardOnly")})`,
    }),
  },
];
