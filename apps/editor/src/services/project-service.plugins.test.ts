import { describe, expect, it } from "vitest";
import { PROJECT_FILE } from "@babylonslate/core";
import {
  createDefaultPluginSettings,
  encodeBabasset,
  writeProjectPlugin,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

async function scaffolded() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Plugins.babproject");
  const service = new ProjectService(storage);
  await service.loadCurrentProject();
  return { storage, service };
}

async function writeClassAsset(
  storage: MemoryStorageAdapter,
  path: string,
  options: { guid: string; name: string },
) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await storage.mkdir(dir, true);
  await storage.writeBinary(
    path,
    await encodeBabasset({
      header: {
        guid: options.guid,
        type: "Class",
        name: options.name,
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: "Actor",
        payload: {},
      },
      chunks: [
        {
          id: "payload",
          kind: "payload",
          mime: "application/octet-stream",
          data: new Uint8Array([1]),
        },
      ],
    }),
  );
}

describe("ProjectService plugin roots", () => {
  it("mounts enabled-by-default project plugins when opening", async () => {
    const { storage, service } = await scaffolded();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    settings.enabledByDefault = true;
    await writeProjectPlugin(storage, "pack", settings);
    await writeClassAsset(storage, "plugins/pack/assets/PackActor.class.babasset", {
      guid: "pack-actor",
      name: "PackActor",
    });

    await service.remountRegistry();
    expect(service.registry?.getRoot("plugin:pack-guid")).toBeTruthy();
    expect(service.registry?.getByGuid("pack-actor")?.header.name).toBe(
      "PackActor",
    );
    expect(
      service.registry?.listDocumentPaths({ rootId: "project" }).graphs,
    ).not.toContain("plugins/pack/assets/PackActor.class.babasset");
  });

  it("leaves disabled plugins unmounted", async () => {
    const { storage, service } = await scaffolded();
    const settings = createDefaultPluginSettings({
      pluginGuid: "off-guid",
      displayName: "Off",
    });
    settings.enabledByDefault = false;
    await writeProjectPlugin(storage, "off", settings);
    await writeClassAsset(storage, "plugins/off/assets/Hidden.class.babasset", {
      guid: "hidden-class",
      name: "Hidden",
    });

    await service.remountRegistry();
    expect(service.registry?.getRoot("plugin:off-guid")).toBeUndefined();
    expect(service.registry?.getByGuid("hidden-class")).toBeUndefined();
  });

  it("creates a project plugin folder from New Plugin", async () => {
    const { storage, service } = await scaffolded();
    const created = await service.createProjectPlugin("My Pack");
    expect(created.settings.displayName).toBe("My Pack");
    expect(await storage.exists("plugins/my-pack/my-pack.plugin.babasset")).toBe(
      true,
    );
    expect(await storage.exists("plugins/my-pack/assets")).toBe(true);
    expect(await storage.exists(PROJECT_FILE)).toBe(true);
  });
});
