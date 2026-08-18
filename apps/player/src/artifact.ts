import { normalizeScene, type SerializedScene } from "@babylonslate/core";
import {
  normalizeUserInterfaceDocument,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";
import {
  createHttpPackSource,
  createMemoryPackSource,
  parseGameManifest,
  parseScriptRegistry,
  GAME_MANIFEST_FILE,
  SCRIPTS_FILE,
  NAVMESH_EXPORT_TYPE,
  sceneGuidFromNavmeshExport,
  AUDIO_REVERB_EXPORT_TYPE,
  sceneGuidFromAudioReverbExport,
  type GameManifest,
  type PackSource,
} from "@babylonslate/exporter";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  decodePackedAudioAsset,
  normalizeAudioPayload,
  type AudioPayload,
} from "@babylonslate/assets";

const decoder = new TextDecoder();

export type LoadedGame = {
  manifest: GameManifest;
  scripts: ScriptBundleEntry[];
  scenes: Map<string, SerializedScene>;
  textureBytes: Map<string, Uint8Array>;
  modelBytes: Map<string, Uint8Array>;
  fontBytes: Map<string, Uint8Array>;
  fontFamilies: Map<string, string>;
  audioBytes: Map<string, Uint8Array>;
  audioPayloads: Map<string, AudioPayload>;
  payloads: Map<string, Uint8Array>;
  navmeshBytes: Map<string, Uint8Array>;
  audioReverbBytes: Map<string, Uint8Array>;
  userInterfaces: Map<string, UserInterfaceDocument>;
};

function textFromFiles(files: Map<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Export is missing ${name}`);
  return decoder.decode(bytes);
}

function packSourceFor(
  files: Map<string, Uint8Array>,
  packName: string,
  fetchImpl?: typeof fetch,
  baseUrl?: string,
): PackSource {
  const bytes = files.get(packName);
  if (bytes) return createMemoryPackSource(bytes);
  if (!baseUrl || !fetchImpl) {
    throw new Error(`Pack ${packName} is not in memory and no HTTP source was given`);
  }
  return createHttpPackSource(new URL(packName, baseUrl).href, undefined, fetchImpl);
}

async function readAssetBytes(
  source: PackSource | null,
  files: Map<string, Uint8Array>,
  guid: string,
  path?: string,
): Promise<Uint8Array> {
  if (path) {
    const loose = files.get(path);
    if (loose) return loose;
  }
  if (source) return source.read(guid);
  throw new Error(`Missing bytes for ${guid}`);
}

function parseJsonAsset(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export async function loadGameFromFiles(
  files: Map<string, Uint8Array>,
  options: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<LoadedGame> {
  const manifest = parseGameManifest(textFromFiles(files, GAME_MANIFEST_FILE));
  const scripts = parseScriptRegistry(textFromFiles(files, SCRIPTS_FILE));
  const scenes = new Map<string, SerializedScene>();
  const textureBytes = new Map<string, Uint8Array>();
  const modelBytes = new Map<string, Uint8Array>();
  const fontBytes = new Map<string, Uint8Array>();
  const fontFamilies = new Map<string, string>();
  const audioBytes = new Map<string, Uint8Array>();
  const audioPayloads = new Map<string, AudioPayload>();
  const payloads = new Map<string, Uint8Array>();
  const navmeshBytes = new Map<string, Uint8Array>();
  const audioReverbBytes = new Map<string, Uint8Array>();
  const userInterfaces = new Map<string, UserInterfaceDocument>();

  const packSources = new Map<string, PackSource>();
  for (const packName of manifest.packs) {
    packSources.set(
      packName,
      packSourceFor(files, packName, options.fetchImpl, options.baseUrl),
    );
  }

  for (const entry of manifest.assets ?? []) {
    const source = entry.pack ? packSources.get(entry.pack) ?? null : null;
    const bytes = await readAssetBytes(source, files, entry.guid, entry.path);
    payloads.set(entry.guid, bytes);
    if (entry.type === "Scene") {
      scenes.set(entry.guid, normalizeScene(parseJsonAsset(bytes)));
      continue;
    }
    if (entry.type === "Texture") {
      textureBytes.set(entry.guid, bytes);
      continue;
    }
    if (entry.type === "Model") {
      modelBytes.set(entry.guid, bytes);
      continue;
    }
    if (entry.type === "Font") {
      fontBytes.set(entry.guid, bytes);
      if (entry.name?.trim()) fontFamilies.set(entry.guid, entry.name.trim());
      continue;
    }
    if (entry.type === "Audio") {
      const packed = decodePackedAudioAsset(bytes);
      if (packed) {
        audioBytes.set(entry.guid, packed.source);
        audioPayloads.set(entry.guid, packed.payload);
      } else {
        audioBytes.set(entry.guid, bytes);
        audioPayloads.set(entry.guid, normalizeAudioPayload({}));
      }
      continue;
    }
    if (entry.type === NAVMESH_EXPORT_TYPE) {
      const sceneGuid = sceneGuidFromNavmeshExport(entry.guid) ?? entry.guid;
      navmeshBytes.set(sceneGuid, bytes);
      continue;
    }
    if (entry.type === AUDIO_REVERB_EXPORT_TYPE) {
      const sceneGuid = sceneGuidFromAudioReverbExport(entry.guid) ?? entry.guid;
      audioReverbBytes.set(sceneGuid, bytes);
      continue;
    }
    if (entry.type === "UserInterface") {
      userInterfaces.set(entry.guid, normalizeUserInterfaceDocument(parseJsonAsset(bytes)));
      continue;
    }
  }

  return {
    manifest,
    scripts,
    scenes,
    textureBytes,
    modelBytes,
    fontBytes,
    fontFamilies,
    audioBytes,
    audioPayloads,
    payloads,
    navmeshBytes,
    audioReverbBytes,
    userInterfaces,
  };
}

export async function loadGameFromHttp(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedGame> {
  const manifestUrl = new URL(GAME_MANIFEST_FILE, baseUrl).href;
  const scriptsUrl = new URL(SCRIPTS_FILE, baseUrl).href;
  const [manifestRes, scriptsRes] = await Promise.all([
    fetchImpl(manifestUrl),
    fetchImpl(scriptsUrl),
  ]);
  if (!manifestRes.ok) throw new Error("Export is missing game.json");
  const files = new Map<string, Uint8Array>([
    [GAME_MANIFEST_FILE, new Uint8Array(await manifestRes.arrayBuffer())],
    [SCRIPTS_FILE, new Uint8Array(await scriptsRes.arrayBuffer())],
  ]);
  const manifest = parseGameManifest(decoder.decode(files.get(GAME_MANIFEST_FILE)));
  if (manifest.mode === "loose") {
    for (const entry of manifest.assets ?? []) {
      if (!entry.path) continue;
      const response = await fetchImpl(new URL(entry.path, baseUrl).href);
      if (response.ok) {
        files.set(entry.path, new Uint8Array(await response.arrayBuffer()));
      }
    }
  }
  return loadGameFromFiles(files, { fetchImpl, baseUrl });
}
