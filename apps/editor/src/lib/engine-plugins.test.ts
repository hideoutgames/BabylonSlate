import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssetRegistry, STARTER_CONTENT_PLUGIN_GUID, buildStarterContentFiles, discoverEnginePlugins } from "@babylonslate/assets";
import type { HttpStorageCatalog } from "@babylonslate/vfs";
import { enginePluginsVitePlugin } from "../../vite-engine-plugins";
import { loadEnginePluginStorage } from "./engine-plugins";

describe("loadEnginePluginStorage", () => {
  it("mounts bundled catalogs without downloading archives or unused document chunks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "engine-catalog-"));
    try {
      const sourceDir = join(directory, "source"), publicDir = join(directory, "public");
      for (const file of await buildStarterContentFiles()) {
        const destination = join(sourceDir, "starter-content", file.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, file.data);
      }
      const plugin = enginePluginsVitePlugin({ sourceDir, publicDir });
      await (plugin.configResolved as () => Promise<void>)();
      const index = JSON.parse(readFileSync(join(publicDir, "index.json"), "utf8")) as HttpStorageCatalog;
      const requests: string[] = [];
      const fetchFn: typeof fetch = async function (this: unknown, input) {
        expect(this).toBeUndefined();
        const file = String(input).split("engine-plugins/")[1]!;
        requests.push(file);
        return new Response(new Uint8Array(readFileSync(join(publicDir, file))));
      };
      const storage = await loadEnginePluginStorage({ fetch: fetchFn, baseUrl: "/" });
      expect(requests).toEqual(["index.json"]);
      const discovered = await discoverEnginePlugins(storage);
      expect(discovered.map(entry => entry.pluginGuid)).toEqual([STARTER_CONTENT_PLUGIN_GUID]);
      expect(discovered[0]).toMatchObject({ folderPath: "starter-content", readOnly: true });
      const registry = new AssetRegistry(storage);
      await registry.mountRoot({ id: "plugin", kind: "plugin", pathPrefix: "starter-content/assets", readOnly: true });
      const actor = index.files.find(file => file.path.endsWith("StarterActor.class.babasset"))!;
      const payloadFiles = actor.parts.filter(part => part.offset >= actor.parts[0]!.length + actor.parts[1]!.length).map(part => part.file);
      for (const file of payloadFiles) expect(requests).not.toContain(file);
      expect(requests.some(file => file.endsWith(".babplugin"))).toBe(false);
      expect(await storage.exists(actor.path)).toBe(true);
      const selected = registry.list().find(entry => entry.path === actor.path)!;
      expect((await registry.readAssetDocument(selected.header.guid)).guid).toBe(selected.header.guid);
      for (const file of payloadFiles) expect(requests).toContain(file);
      await expect(storage.writeBinary("starter-content/assets/hack", new Uint8Array([1]))).rejects.toThrow(/read-only/i);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("returns empty storage when the index is missing", async () => {
    const storage = await loadEnginePluginStorage({ fetch: async () => new Response("missing", { status: 404 }), baseUrl: "/" });
    expect(await discoverEnginePlugins(storage)).toEqual([]);
  });
});
