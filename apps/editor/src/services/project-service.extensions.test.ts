import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "@babylonslate/core";
import { createEmptyProjectFiles, createExtensionSettings, writeProjectExtension, type ExtensionDescriptor } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { lowerMaterialDocument } from "@babylonslate/shader-graph";
import { ProjectService } from "./project-service";
import { ensureEngineExtensionStorage } from "../lib/engine-extensions";

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
  it("runs the bundled converter into an indexed, persisted native Material and keeps output after disabling", async () => {
    const { service, storage, bundled } = await setup();
    expect(service.extensions.getSnapshot().commands).toEqual([]);
    await enable(service, bundled);
    await service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Converted", source: "void main() { gl_FragColor = vec4(0.25, 0.5, 0.75, 1.0); }",
    });
    const material = await service.loadDocument("material", "assets/Converted.material.babasset");
    const graph = material as unknown as Parameters<typeof lowerMaterialDocument>[0];
    expect(graph.nodes.some((node) => node.type === "custom.glsl")).toBe(false);
    expect(lowerMaterialDocument(graph).ok).toBe(true);
    expect(service.registry?.getByPath("assets/Converted.material.babasset")?.header.type).toBe("Material");
    await service.extensions.refresh({ [bundled.extensionGuid]: { enabled: false } });
    expect(service.extensions.getSnapshot().commands).toEqual([]);
    expect(await storage.exists("assets/Converted.material.babasset")).toBe(true);
    await expect(service.extensions.run(bundled.extensionGuid, "glsl-to-material", {})).rejects.toThrow(/unavailable/);
    await service.closeProject();
  });

  it("reports failed conversions without creating assets and allows corrected input without overwriting output", async () => {
    const { service, storage, bundled } = await setup();
    await enable(service, bundled);
    await expect(service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Result", source: "void main() { for (;;) {} }",
    })).rejects.toThrow();
    expect(await storage.exists("assets/Result.material.babasset")).toBe(false);
    await service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Result", source: "void main() { gl_FragColor = vec4(1.0); }",
    });
    const original = await storage.readBinary("assets/Result.material.babasset");
    await expect(service.extensions.run(bundled.extensionGuid, "glsl-to-material", {
      name: "Result", source: "void main() { gl_FragColor = vec4(0.0); }",
    })).rejects.toThrow(/already exists/);
    expect(await storage.readBinary("assets/Result.material.babasset")).toEqual(original);
    await service.closeProject();
  });

  it("persists TS/JS project code through the API and blocks engine paths and open-asset overwrites", async () => {
    const { service, storage } = await setup();
    const entry = await writeProjectExtension(storage, "writer", createExtensionSettings("Writer"), `
      export function activate(api) {
        api.registerCommand({ id: 'write', title: 'Write', execute: async (values) => {
          await api.code.write(values.path, 'export const amount: number = 2;');
        }});
        api.registerCommand({ id: 'update', title: 'Update', execute: async () => {
          const asset = await api.assets.read('assets/Main.scene.babasset');
          await api.assets.update('assets/Main.scene.babasset', asset);
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
});
