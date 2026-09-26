import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionSettings,
  decodeAssetDocument,
  encodeAssetDocument,
  exportExtensionZip,
  writeProjectExtension,
  type ExtensionSettings,
} from "@babylonslate/assets";
import { convertGlslToMaterial } from "@babylonslate/shader-graph";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EditorExtensionService } from "./editor-extension-service";

const activeServices: EditorExtensionService[] = [];

async function storage(name = "project") {
  const result = new MemoryStorageAdapter("documents");
  await result.openDocumentsProject(name);
  return result;
}

async function fixture() {
  const project = await storage();
  const messages: string[] = [];
  const service = new EditorExtensionService(project, {
    assets: {
      list: async () => [],
      read: async (path) => decodeAssetDocument(await project.readBinary(path)),
      create: async (path, document) => {
        await project.writeBinary(path, await encodeAssetDocument({ ...document, guid: "created", version: 1 }));
      },
      update: async (path, document) => {
        await project.writeBinary(path, await encodeAssetDocument(document));
      },
    },
    code: {
      read: (path) => project.readText(path),
      write: async (path, source) => {
        await project.mkdir(path.slice(0, path.lastIndexOf("/")), true);
        await project.writeText(path, source);
      },
    },
    materials: { convertGlsl: convertGlslToMaterial },
    log: (_extensionId, message) => { messages.push(message); },
  });
  activeServices.push(service);
  return { project, service, messages };
}

function enabledSettings(guid: string, extra: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return { ...createExtensionSettings(guid, guid), enabledByDefault: true, ...extra };
}

const originalModule = `
  export function activate(api) {
    api.registerCommand({ id: "run", title: "Run Original", execute() { api.log("Original Worked"); } });
  }
`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeServices.splice(0).map((service) => service.close()));
});

describe("EditorExtensionService lifecycle", () => {
  it("reports cleanup failures when disabling an extension and keeps independent commands usable", async () => {
    const { project, service, messages } = await fixture();
    await writeProjectExtension(project, "faulty", enabledSettings("faulty"), `
      export function activate() { return () => { throw new Error("Listener removal failed"); }; }
    `);
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();

    await service.refresh({ faulty: { enabled: false } });

    expect(service.getSnapshot().diagnostics).toContain("faulty: cleanup failed: Listener removal failed");
    expect(messages).toContain("faulty: cleanup failed: Listener removal failed");
    await service.run("tools", "run", {});
    expect(messages).toContain("Original Worked");
    await service.close();
    expect(service.getSnapshot().diagnostics).toEqual([]);
  });

  it("retries a transient activation failure when the module and settings have not changed", async () => {
    const { project, service, messages } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), `
      export async function activate(api) {
        await api.code.read("code/ready.ts");
        api.registerCommand({ id: "run", title: "Run", execute() { api.log("Ready"); } });
      }
    `);

    await service.refresh();
    expect(service.getSnapshot().commands).toEqual([]);
    expect(service.getSnapshot().diagnostics.length).toBeGreaterThan(0);

    await project.mkdir("code", true);
    await project.writeText("code/ready.ts", "export const ready = true;");
    await service.refresh();

    expect(service.getSnapshot().commands).toMatchObject([{ extensionId: "tools", id: "run" }]);
    expect(service.getSnapshot().diagnostics).toEqual([]);
    await service.run("tools", "run", {});
    expect(messages).toEqual(["Ready"]);
  });

  it("restores the installed module and its commands when replacement storage fails", async () => {
    const { project, service, messages } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();

    const source = await storage("replacement");
    const replacement = await writeProjectExtension(source, "tools", enabledSettings("tools", { version: "2.0.0" }), `
      export function activate(api) {
        api.registerCommand({ id: "replace", title: "Replacement", execute() { api.log("Replacement Ran"); } });
      }
    `);
    const archive = await exportExtensionZip(source, replacement);
    const writeBinary = project.writeBinary.bind(project);
    let failed = false;
    vi.spyOn(project, "writeBinary").mockImplementation(async (path, bytes) => {
      if (!failed && path === "extensions/tools/index.ts") {
        failed = true;
        throw new Error("Storage write failed");
      }
      return writeBinary(path, bytes);
    });

    await expect(service.import(archive, true)).rejects.toThrow("Storage write failed");

    expect(await project.readText("extensions/tools/index.ts")).toBe(originalModule);
    expect(service.getSnapshot().commands).toMatchObject([{ extensionId: "tools", id: "run" }]);
    expect(service.getSnapshot().entries[0]?.settings.version).toBe("1.0.0");
    await service.run("tools", "run", {});
    expect(messages).toEqual(["Original Worked"]);
  });

  it("restores active commands when deleting their package fails", async () => {
    const { project, service, messages } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();
    const remove = project.remove.bind(project);
    vi.spyOn(project, "remove").mockImplementation(async (path) => {
      if (path === "extensions/tools") throw new Error("Storage delete failed");
      return remove(path);
    });

    await expect(service.remove("tools")).rejects.toThrow("Storage delete failed");

    expect(service.getSnapshot().commands).toMatchObject([{ extensionId: "tools", id: "run" }]);
    await service.run("tools", "run", {});
    expect(messages).toEqual(["Original Worked"]);
  });

  it("blocks tools whose dependency failed activation while independent commands remain usable", async () => {
    const { project, service, messages } = await fixture();
    await writeProjectExtension(project, "base", enabledSettings("base"), `
      export async function activate(api) { await api.code.read("code/base-ready.ts"); }
    `);
    await writeProjectExtension(project, "dependent", enabledSettings("dependent", {
      extensionDependencies: [{ guid: "base", version: "1.0.0" }],
    }), `
      export function activate(api) {
        api.log("Dependent Started");
        api.registerCommand({ id: "run", title: "Dependent", execute() {} });
      }
    `);
    await writeProjectExtension(project, "independent", enabledSettings("independent"), `
      export function activate(api) {
        api.registerCommand({ id: "run", title: "Independent", execute() {
          return api.code.write("code/independent.js", "export const worked = true;");
        } });
      }
    `);

    await service.refresh();

    expect(service.getSnapshot().commands.map((command) => command.extensionId)).toEqual(["independent"]);
    expect(messages).not.toContain("Dependent Started");
    await expect(service.run("dependent", "run", {})).rejects.toThrow(/unavailable/);
    await service.run("independent", "run", {});
    expect(await project.readText("code/independent.js")).toBe("export const worked = true;");
  });
});
