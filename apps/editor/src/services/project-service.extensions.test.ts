import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "@haptic/core";
import { createExtensionSettings, encodeAssetDocument, normalizeExtensionContributions, writeProjectExtension, type ExtensionDescriptor } from "@haptic/assets";
import { createEmptyProjectFiles } from "../../../../packages/assets/src/test-support/project-files";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { lowerMaterialDocument } from "@haptic/shader-graph";
import { ProjectService } from "./project-service";
import { defaultNodeRegistry } from "./graph-hydration";
import { ensureEngineExtensionStorage } from "../lib/engine-extensions";

/** Play in the web editor. */
const WEB_PLAY = { platform: "web", editor: true } as const;

async function setup() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Extensions");
  const service = new ProjectService(storage);
  service.setEngineExtensionStorage(await ensureEngineExtensionStorage());
  await service.loadCurrentProject();
  await service.extensions.refresh();
  return { storage, service, bundled: service.extensions.getSnapshot().entries[0]! };
}

async function enable(service: ProjectService, entry: ExtensionDescriptor) {
  await service.extensions.refresh({ [entry.extensionGuid]: { enabled: true } });
}

describe("Editor Extensions in a project", () => {
  it("rejects overlapping asset creates instead of overwriting the first result and releases failed reservations", async () => {
    const { service, storage } = await setup();
    const entry = await writeProjectExtension(storage, "writer", createExtensionSettings("Writer"), `
      export function activate(api) {
        api.registerCommand({ id: "write", title: "Write", async execute() {
          const first = await api.materials.convertGlsl("void main() { gl_FragColor = vec4(0.25); }");
          const second = await api.materials.convertGlsl("void main() { gl_FragColor = vec4(0.75); }");
          if (!first.ok || !second.ok) throw new Error("Fixture conversion failed");
          const document = { type: "Material", name: "Shared", payload: first.document };
          const results = await Promise.allSettled([
            api.assets.create("assets/Shared.material.hasset", document),
            api.assets.create("assets/Shared.material.hasset", { ...document, payload: second.document }),
          ]);
          await api.code.write("code/results.js", JSON.stringify(results.map((result) => result.status)));
          await api.assets.create("assets/Retry.material.hasset", { ...document, type: "Unsupported" }).catch(() => {});
          await api.assets.create("assets/Retry.material.hasset", document);
        } });
      }
    `);
    await enable(service, entry);
    await service.extensions.run(entry.extensionGuid, "write", {});

    expect(JSON.parse(await storage.readText("code/results.js"))).toEqual(["fulfilled", "rejected"]);
    const material = await service.loadDocument("material", "assets/Shared.material.hasset") as unknown as Parameters<typeof lowerMaterialDocument>[0];
    expect(material.nodes.find((node) => node.type === "const.float")?.properties.value).toEqual([0.25]);
    expect(service.registry?.getByPath("assets/Retry.material.hasset")?.header.type).toBe("Material");
    await service.closeProject();
  });

  it("runs the bundled converter into an indexed, persisted native Material and keeps output after disabling", async () => {
    const { service, storage, bundled } = await setup();
    expect(service.extensions.getSnapshot().commands).toEqual([]);
    await enable(service, bundled);
    await service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Converted", source: "void main() { gl_FragColor = vec4(0.25, 0.5, 0.75, 1.0); }",
    });
    const material = await service.loadDocument("material", "assets/Converted.material.hasset");
    const graph = material as unknown as Parameters<typeof lowerMaterialDocument>[0];
    expect(graph.nodes.some((node) => node.type === "custom.glsl")).toBe(false);
    expect(lowerMaterialDocument(graph).ok).toBe(true);
    expect(service.registry?.getByPath("assets/Converted.material.hasset")?.header.type).toBe("Material");
    await service.extensions.refresh({ [bundled.extensionGuid]: { enabled: false } });
    expect(service.extensions.getSnapshot().commands).toEqual([]);
    expect(await storage.exists("assets/Converted.material.hasset")).toBe(true);
    await expect(service.extensions.run(bundled.extensionGuid, "glsl-to-material", {})).rejects.toThrow(/unavailable/);
    await service.closeProject();
  });

  it("reports failed conversions without creating assets and allows corrected input without overwriting output", async () => {
    const { service, storage, bundled } = await setup();
    await enable(service, bundled);
    await expect(service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Result", source: "void main() { for (;;) {} }",
    })).rejects.toThrow();
    expect(await storage.exists("assets/Result.material.hasset")).toBe(false);
    await service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Result", source: "void main() { gl_FragColor = vec4(1.0); }",
    });
    const original = await storage.readBinary("assets/Result.material.hasset");
    await expect(service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Result", source: "void main() { gl_FragColor = vec4(0.0); }",
    })).rejects.toThrow(/already exists/);
    expect(await storage.readBinary("assets/Result.material.hasset")).toEqual(original);
    await service.closeProject();
  });

  it("persists TS/JS project code through the API and blocks engine paths and open-asset overwrites", async () => {
    const { service, storage } = await setup();
    const entry = await writeProjectExtension(storage, "writer", createExtensionSettings("Writer"), `
      export function activate(api) {
        api.registerCommand({ id: 'write', title: 'Write', fields: [{ id: 'path', label: 'Path', type: 'text' }], execute: async (values) => {
          await api.code.write(values.path, 'export const amount: number = 2;');
        }});
        api.registerCommand({ id: 'update', title: 'Update', execute: async () => {
          const asset = await api.assets.read('assets/main.scene.hasset');
          await api.assets.update('assets/main.scene.hasset', asset);
        }});
      }
    `);
    await enable(service, entry);
    await service.extensions.run(entry.extensionGuid, "write", { path: "code/amount.ts" });
    expect(await storage.readText("code/amount.ts")).toBe("export const amount: number = 2;");
    await expect(service.extensions.run(entry.extensionGuid, "write", { path: "../packages/render/engine.ts" })).rejects.toThrow(/project code/);
    service.extensions.setAssetWriteGuard(() => { throw new Error("Close the open asset first."); });
    await expect(service.extensions.run(entry.extensionGuid, "update", {})).rejects.toThrow(/Close/);
    await service.closeProject();
    expect(service.extensions.getSnapshot().commands).toEqual([]);
  });

  it("copies engine defaults into a new template project and persists independent project enablement", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    service.setEngineExtensionStorage(await ensureEngineExtensionStorage());
    await service.createFromTemplate({ name: "From Template", templateFiles: createEmptyProjectFiles({ guid: "template", name: "Template" }) });
    await service.extensions.refresh();
    const entry = service.extensions.getSnapshot().entries[0]!;
    expect(entry.source).toBe("project");
    expect(await storage.exists(`${entry.folderPath}/index.js`)).toBe(true);
    const settings = normalizeProjectSettings({ ...createEmptyProject("Example").settings, extensionOverrides: { [entry.extensionGuid]: { enabled: true } } });
    expect(settings.extensionOverrides[entry.extensionGuid]?.enabled).toBe(true);
    expect(settings.pluginOverrides).toEqual({});
    await service.closeProject();
  });

  it("mounts a gameplay extension's assets for the project and export, keeps them across a rescan and unmounts them when disabled", async () => {
    const { service, storage } = await setup();
    const entry = await writeProjectExtension(storage, "weather", { ...createExtensionSettings("Weather", "weather"), editorOnly: false }, "export function activate() {}");
    await storage.writeText("extensions/weather/game.ts", "export const ready = true;");
    await storage.writeBinary("extensions/weather/assets/Rain.material.hasset", await encodeAssetDocument({ type: "Material", name: "Rain", guid: "rain", version: 1, payload: {} }));
    let changes = 0;
    service.onRegistryChange(() => { changes += 1; });

    await enable(service, entry);

    expect(changes).toBeGreaterThan(0);
    expect(service.registry?.getByGuid("rain")?.rootId).toBe("extension:weather");
    expect((await service.listExportAssets(new Set())).some((asset) => asset.header.guid === "rain")).toBe(true);
    await service.remountRegistry();
    expect(service.registry?.getByGuid("rain")?.path).toBe("extensions/weather/assets/Rain.material.hasset");

    await service.extensions.refresh({ weather: { enabled: false } });

    expect(service.registry?.getRoot("extension:weather")).toBeUndefined();
    expect(service.registry?.getByGuid("rain")).toBeUndefined();
    await service.closeProject();
  });

  it("authors an enabled extension's asset type from its code, keeps its type and name on save and links it into the game library", async () => {
    const { service, storage } = await setup();
    const contributes = normalizeExtensionContributions({ assetTypes: [{ id: "preset", title: "Weather Preset", editorOnly: false,
      sections: [{ id: "sky", title: "Sky", fields: [{ id: "rain", label: "Rain", type: "number", default: 1, max: 10 }] }] }] });
    const entry = await writeProjectExtension(storage, "weather", { ...createExtensionSettings("Weather", "weather"), editorOnly: false, contributes }, `
      export function activate(api) {
        api.registerCommand({ id: "make", title: "Make", async execute() {
          await api.assets.create("assets/Rain.hasset", { type: "extension.weather.preset", name: "Rain", payload: { rain: 50, stray: true } });
          const refused = await api.assets.create("assets/Other.hasset", { type: "extension.other.preset", name: "Other", payload: {} }).then(() => "created", (error) => error.message);
          return refused;
        } });
      }
    `);
    await storage.writeText("extensions/weather/game.ts", "export const ready = true;");
    await enable(service, entry);

    expect(await service.extensions.run(entry.extensionGuid, "make", {})).toBe("Extension cannot author this asset type: extension.other.preset");
    const rain = service.registry?.getByPath("assets/Rain.hasset");
    expect(rain?.header.type).toBe("extension.weather.preset");
    expect(await service.loadDocument("extension-asset", "assets/Rain.hasset")).toEqual({ rain: 10 });

    await service.saveDocument("extension-asset", "assets/Rain.hasset", { rain: 4 });
    const saved = service.registry?.getByPath("assets/Rain.hasset");
    expect([saved?.header.type, saved?.header.name]).toEqual(["extension.weather.preset", "Rain"]);
    const [library] = await service.extensions.gameLibraries(WEB_PLAY);
    expect(library!.assets).toEqual([{ guid: rain!.header.guid, name: "Rain", type: "preset", values: { rain: 4 } }]);
    await service.closeProject();
  });

  it("adds an enabled gameplay extension's graph nodes to the editor's node registry and removes them when disabled", async () => {
    const { service, storage } = await setup();
    const contributes = normalizeExtensionContributions({ nodes: [{ id: "ping", title: "Ping", call: "ping", outputs: [{ id: "ok", name: "OK", type: "bool" }] }] });
    const entry = await writeProjectExtension(storage, "pinger", { ...createExtensionSettings("Pinger", "pinger"), contributes }, "export function activate() {}");

    await enable(service, entry);
    expect(defaultNodeRegistry().get("extension.pinger.ping")).toBeUndefined();
    expect(service.extensions.getSnapshot().diagnostics).toContain("Pinger: its graph nodes appear only while Editor Only is off.");

    await service.extensions.save("pinger", { ...service.extensions.getSnapshot().entries.find((value) => value.extensionGuid === "pinger")!.settings, editorOnly: false },
      { write: [{ path: "game.ts", source: "export const ping = () => true;" }], remove: [] });
    expect(defaultNodeRegistry().get("extension.pinger.ping")?.title).toBe("Ping");

    await service.extensions.refresh({ pinger: { enabled: false } });
    expect(defaultNodeRegistry().get("extension.pinger.ping")).toBeUndefined();
    await service.closeProject();
  });
});
