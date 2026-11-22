import {
  DEFAULT_EXPORT_FILE_COUNT_FAIL,
  DEFAULT_EXPORT_FILE_COUNT_WARN,
} from "@haptic/core";

export const MISSING_STARTUP_SCENE_MESSAGE =
  "Set Startup Scene in Project Settings.";

export const DEFAULT_FILE_COUNT_WARN = DEFAULT_EXPORT_FILE_COUNT_WARN;
export const DEFAULT_FILE_COUNT_FAIL = DEFAULT_EXPORT_FILE_COUNT_FAIL;

export const GAME_MANIFEST_FILE = "game.json";
export const NAVMESH_EXPORT_TYPE = "NavMesh";
const NAVMESH_EXPORT_GUID_PREFIX = "navmesh:";
export const AUDIO_REVERB_EXPORT_TYPE = "AudioReverb";
const AUDIO_REVERB_EXPORT_GUID_PREFIX = "audioReverb:";
export const LANDSCAPE_EXPORT_TYPE = "Landscape";
const LANDSCAPE_EXPORT_GUID_PREFIX = "landscape:";
export const FOLIAGE_EXPORT_TYPE = "Foliage";
const FOLIAGE_EXPORT_GUID_PREFIX = "foliage:";
export const FONT_FACETYPE_EXPORT_TYPE = "FontFacetype";
export const AREA_EMISSION_EXPORT_TYPE = "AreaEmission";
const AREA_EMISSION_EXPORT_PREFIX = "area-emission:";
export const areaEmissionExportGuid = (guid: string): string => `${AREA_EMISSION_EXPORT_PREFIX}${guid}`;
export const textureGuidFromAreaEmissionExport = (guid: string): string | null => guid.startsWith(AREA_EMISSION_EXPORT_PREFIX) ? guid.slice(AREA_EMISSION_EXPORT_PREFIX.length) : null;
const FONT_FACETYPE_EXPORT_GUID_PREFIX = "font-facetype:";
export const FONT_MSDF_EXPORT_TYPE = "FontMsdf";
const FONT_MSDF_EXPORT_GUID_PREFIX = "font-msdf:";
export const FONT_MSDF_ATLAS_EXPORT_TYPE = "FontMsdfAtlas";
const FONT_MSDF_ATLAS_EXPORT_GUID_PREFIX = "font-msdf-png:";

export function navmeshExportGuid(sceneGuid: string): string {
  return `${NAVMESH_EXPORT_GUID_PREFIX}${sceneGuid}`;
}

export function sceneGuidFromNavmeshExport(guid: string): string | null {
  return guid.startsWith(NAVMESH_EXPORT_GUID_PREFIX)
    ? guid.slice(NAVMESH_EXPORT_GUID_PREFIX.length)
    : null;
}

export function audioReverbExportGuid(sceneGuid: string): string {
  return `${AUDIO_REVERB_EXPORT_GUID_PREFIX}${sceneGuid}`;
}

export function sceneGuidFromAudioReverbExport(guid: string): string | null {
  return guid.startsWith(AUDIO_REVERB_EXPORT_GUID_PREFIX)
    ? guid.slice(AUDIO_REVERB_EXPORT_GUID_PREFIX.length)
    : null;
}

/**
 * Key of a Scene's binary component chunk (Landscape `HPLD`, Foliage `HPFG`) inside
 * `GameSourceContent.componentChunks` and `sceneComponentChunks`: `<ownerGuid>:<chunkId>`.
 */
export function componentChunkKey(ownerGuid: string, chunkId: string): string {
  return `${ownerGuid}:${chunkId}`;
}

/** Manifest sidecar asset guid for a binary `HPLD` landscape chunk (`landscape:<ownerGuid>:<chunkId>`). */
export function landscapeExportGuid(ownerGuid: string, chunkId: string): string {
  return `${LANDSCAPE_EXPORT_GUID_PREFIX}${componentChunkKey(ownerGuid, chunkId)}`;
}

/** Manifest sidecar asset guid for a binary `HPFG` foliage chunk (`foliage:<ownerGuid>:<chunkId>`). */
export function foliageExportGuid(ownerGuid: string, chunkId: string): string {
  return `${FOLIAGE_EXPORT_GUID_PREFIX}${componentChunkKey(ownerGuid, chunkId)}`;
}

/** Returns `<ownerGuid>:<chunkId>` for a `Landscape` or `Foliage` export sidecar guid, or null. */
export function componentChunkKeyFromExport(guid: string): string | null {
  if (guid.startsWith(LANDSCAPE_EXPORT_GUID_PREFIX)) return guid.slice(LANDSCAPE_EXPORT_GUID_PREFIX.length);
  if (guid.startsWith(FOLIAGE_EXPORT_GUID_PREFIX)) return guid.slice(FOLIAGE_EXPORT_GUID_PREFIX.length);
  return null;
}

export function fontFacetypeExportGuid(fontGuid: string): string {
  return `${FONT_FACETYPE_EXPORT_GUID_PREFIX}${fontGuid}`;
}

export function fontGuidFromFontFacetypeExport(guid: string): string | null {
  return guid.startsWith(FONT_FACETYPE_EXPORT_GUID_PREFIX)
    ? guid.slice(FONT_FACETYPE_EXPORT_GUID_PREFIX.length)
    : null;
}

export function fontMsdfExportGuid(fontGuid: string): string {
  return `${FONT_MSDF_EXPORT_GUID_PREFIX}${fontGuid}`;
}

export function fontGuidFromFontMsdfExport(guid: string): string | null {
  return guid.startsWith(FONT_MSDF_EXPORT_GUID_PREFIX)
    ? guid.slice(FONT_MSDF_EXPORT_GUID_PREFIX.length)
    : null;
}

export function fontMsdfAtlasExportGuid(fontGuid: string): string {
  return `${FONT_MSDF_ATLAS_EXPORT_GUID_PREFIX}${fontGuid}`;
}

export function fontGuidFromFontMsdfAtlasExport(guid: string): string | null {
  return guid.startsWith(FONT_MSDF_ATLAS_EXPORT_GUID_PREFIX)
    ? guid.slice(FONT_MSDF_ATLAS_EXPORT_GUID_PREFIX.length)
    : null;
}
