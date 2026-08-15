import { describe, expect, it } from "vitest";
import {
  STARTER_CONTENT_FOLDER,
  STARTER_CONTENT_PLUGIN_GUID,
  buildStarterContentFiles,
  discoverEnginePlugins,
  packEnginePluginFiles,
} from "@babylonslate/assets";
import { loadEnginePluginStorage } from "./engine-plugins";

describe("loadEnginePluginStorage", () => {
  it("fetches index.json and unpacks each .babplugin at the storage root", async () => {
    const files = await buildStarterContentFiles();
    const packed = await packEnginePluginFiles(files, {
      id: STARTER_CONTENT_FOLDER,
    });
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("engine-plugins/index.json")) {
        return new Response(
          JSON.stringify([
            { id: "starter-content", file: "starter-content.babplugin" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("engine-plugins/starter-content.babplugin")) {
        return new Response(packed.zip, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const storage = await loadEnginePluginStorage({
      fetch: fetchFn,
      baseUrl: "/",
    });
    const discovered = await discoverEnginePlugins(storage);
    expect(discovered.map((plugin) => plugin.pluginGuid)).toEqual([
      STARTER_CONTENT_PLUGIN_GUID,
    ]);
    expect(discovered[0]!.folderPath).toBe("starter-content");
    expect(discovered[0]!.readOnly).toBe(true);
    expect(
      await storage.exists("starter-content/assets/StarterActor.class.babasset"),
    ).toBe(true);
    await expect(
      storage.writeBinary(
        "starter-content/assets/hack.class.babasset",
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/read-only/i);
  });

  it("returns empty storage when the index is missing", async () => {
    const storage = await loadEnginePluginStorage({
      fetch: async () => new Response("missing", { status: 404 }),
      baseUrl: "/",
    });
    expect(await discoverEnginePlugins(storage)).toEqual([]);
  });
});
