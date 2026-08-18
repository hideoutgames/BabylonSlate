import {
  DEFAULT_EXPORT_FILE_COUNT_FAIL,
  DEFAULT_EXPORT_FILE_COUNT_WARN,
} from "@babylonslate/core";

export const MISSING_STARTUP_SCENE_MESSAGE =
  "Set Startup Scene in Project Settings.";

export const DEFAULT_FILE_COUNT_WARN = DEFAULT_EXPORT_FILE_COUNT_WARN;
export const DEFAULT_FILE_COUNT_FAIL = DEFAULT_EXPORT_FILE_COUNT_FAIL;

export const BABPACK_MAGIC = "BPK1";
export const GAME_MANIFEST_FILE = "game.json";
export const SCRIPTS_FILE = "scripts.js";
export const BOOT_PACK_FILE = "boot.babpack";
export const NAVMESH_EXPORT_TYPE = "NavMesh";
export const NAVMESH_EXPORT_GUID_PREFIX = "navmesh:";
export const UI_IMAGE_EXPORT_TYPE = "UiImage";
export const UI_IMAGE_EXPORT_GUID_PREFIX = "uiimage:";

export function navmeshExportGuid(sceneGuid: string): string {
  return `${NAVMESH_EXPORT_GUID_PREFIX}${sceneGuid}`;
}

export function sceneGuidFromNavmeshExport(guid: string): string | null {
  return guid.startsWith(NAVMESH_EXPORT_GUID_PREFIX)
    ? guid.slice(NAVMESH_EXPORT_GUID_PREFIX.length)
    : null;
}

export function uiImageExportGuid(textureGuid: string): string {
  return `${UI_IMAGE_EXPORT_GUID_PREFIX}${textureGuid}`;
}

export function textureGuidFromUiImageExport(guid: string): string | null {
  return guid.startsWith(UI_IMAGE_EXPORT_GUID_PREFIX)
    ? guid.slice(UI_IMAGE_EXPORT_GUID_PREFIX.length)
    : null;
}
