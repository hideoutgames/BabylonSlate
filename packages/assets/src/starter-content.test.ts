import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { decodeAssetDocument } from "./asset-document";
import { readBabassetHeader } from "./babasset";
import { bytesEqual } from "./bytes";
import { discoverEnginePlugins } from "./plugin-host";
import { PLUGIN_SETTINGS_TYPE } from "./plugin-settings";
import {
  STARTER_ACTOR_CLASS_NAME,
  STARTER_ACTOR_GUID,
  STARTER_CONTENT_DISPLAY_NAME,
  STARTER_CONTENT_FOLDER,
  STARTER_CONTENT_PLUGIN_GUID,
  buildStarterContentFiles,
} from "./starter-content";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("buildStarterContentFiles", () => {
  it("authors Starter Content PluginSettings and a StarterActor class", async () => {
    const files = await buildStarterContentFiles();
    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual([
      "assets/StarterActor.class.babasset",
      "starter-content.plugin.babasset",
    ]);

    const settingsDoc = await decodeAssetDocument(
      files.find((file) => file.path === "starter-content.plugin.babasset")!.data,
    );
    expect(settingsDoc.type).toBe(PLUGIN_SETTINGS_TYPE);
    expect(settingsDoc.guid).toBe(STARTER_CONTENT_PLUGIN_GUID);
    expect(settingsDoc.name).toBe(STARTER_CONTENT_DISPLAY_NAME);
    const payload = settingsDoc.payload as {
      displayName: string;
      enabledByDefault: boolean;
      iconKey: string | null;
      pluginGuid: string;
    };
    expect(payload.displayName).toBe("Starter Content");
    expect(payload.pluginGuid).toBe(STARTER_CONTENT_PLUGIN_GUID);
    expect(payload.enabledByDefault).toBe(false);
    expect(payload.iconKey).toBe("Puzzle");

    const actorHeader = readBabassetHeader(
      files.find((file) => file.path === "assets/StarterActor.class.babasset")!
        .data,
    );
    expect(actorHeader.guid).toBe(STARTER_ACTOR_GUID);
    expect(actorHeader.type).toBe("Class");
    expect(actorHeader.name).toBe(STARTER_ACTOR_CLASS_NAME);
    expect(actorHeader.parentClass).toBe("Actor");
  });

  it("is discoverable as a read-only engine plugin at the storage root", async () => {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-plugins");
    const files = await buildStarterContentFiles();
    await storage.mkdir(`${STARTER_CONTENT_FOLDER}/assets`, true);
    for (const file of files) {
      await storage.writeBinary(
        `${STARTER_CONTENT_FOLDER}/${file.path}`,
        file.data,
      );
    }

    const discovered = await discoverEnginePlugins(storage);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.pluginGuid).toBe(STARTER_CONTENT_PLUGIN_GUID);
    expect(discovered[0]!.source).toBe("engine");
    expect(discovered[0]!.readOnly).toBe(true);
    expect(discovered[0]!.folderPath).toBe(STARTER_CONTENT_FOLDER);
    expect(discovered[0]!.settings.enabledByDefault).toBe(false);
  });

  it("matches the committed engine-plugins/starter-content directory", async () => {
    const files = await buildStarterContentFiles();
    const dir = join(REPO_ROOT, "engine-plugins", STARTER_CONTENT_FOLDER);
    if (UPDATE) {
      for (const file of files) {
        const path = join(dir, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.data);
      }
    }
    expect(existsSync(dir)).toBe(true);
    for (const file of files) {
      const onDisk = new Uint8Array(readFileSync(join(dir, file.path)));
      expect(bytesEqual(onDisk, file.data)).toBe(true);
    }
  });
});
