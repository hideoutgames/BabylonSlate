import { decodeExtensionSettings } from "@haptic/assets";
import { createReadOnlyProjectStorage, MemoryStorageAdapter } from "@haptic/vfs";
import type { ProjectStorage } from "@haptic/core";
import glslManifest from "../../../../engine-extensions/glsl-to-material/extension.json?raw";
import glslEditor from "../../../../engine-extensions/glsl-to-material/index.js?raw";
import discordManifest from "../../../../engine-extensions/discord-rich-presence/extension.json?raw";
import discordEditor from "../../../../engine-extensions/discord-rich-presence/index.ts?raw";
import discordGame from "../../../../engine-extensions/discord-rich-presence/game.ts?raw";

/** A bundled extension: its folder under `engine-extensions/`, manifest and code files by path. */
interface BundledExtension {
  folder: string;
  manifest: string;
  files: Readonly<Record<string, string>>;
}

const BUNDLED: readonly BundledExtension[] = [
  { folder: "glsl-to-material", manifest: glslManifest, files: { "index.js": glslEditor } },
  { folder: "discord-rich-presence", manifest: discordManifest, files: { "index.ts": discordEditor, "game.ts": discordGame } },
];

let bundled: Promise<ProjectStorage> | null = null;

/** Bundled extensions; only a gameplay (not Editor Only) one reaches games, as a linked library and a content root. */
export function ensureEngineExtensionStorage(): Promise<ProjectStorage> {
  bundled ??= (async () => {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("bundled-engine-extensions");
    for (const extension of BUNDLED) {
      const settings = decodeExtensionSettings(new TextEncoder().encode(extension.manifest));
      const entries = [settings.entryPoint, ...(settings.editorOnly ? [] : [settings.gameEntryPoint])];
      const missing = entries.filter((entry) => extension.files[entry] === undefined);
      if (missing.length) throw new Error(`Bundled extension ${extension.folder} has no ${missing.join(", ")}.`);
      await storage.mkdir(`${extension.folder}/assets`, true);
      await storage.writeText(`${extension.folder}/extension.json`, extension.manifest);
      for (const [path, source] of Object.entries(extension.files)) await storage.writeText(`${extension.folder}/${path}`, source);
    }
    return createReadOnlyProjectStorage(storage);
  })();
  return bundled;
}
