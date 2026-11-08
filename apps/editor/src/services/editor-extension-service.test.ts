import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionSettings,
  decodeAssetDocument,
  encodeAssetDocument,
  exportExtensionZip,
  writeProjectExtension,
  type ExtensionSettings,
} from "@haptic/assets";
import { loadExtensionGameLibraries } from "@haptic/core";
import { convertGlslToMaterial } from "@haptic/shader-graph";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { EditorExtensionService, type EditorExtensionWriteOptions } from "./editor-extension-service";
import { ProjectWriteAdmission } from "./project-write-admission";

const activeServices: EditorExtensionService[] = [];

async function storage(name = "project") {
  const result = new MemoryStorageAdapter("documents");
  await result.openDocumentsProject(name);
  return result;
}

async function fixture(options?: EditorExtensionWriteOptions) {
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
  }, options);
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
  vi.unstubAllGlobals();
});

describe("EditorExtensionService lifecycle", () => {
  it("keeps package and guest code/asset writes behind project admission while read-only commands remain usable", async () => {
    const admission = new ProjectWriteAdmission();
    const { project, service, messages } = await fixture({ runAuthoringWrite: work => admission.run(work) });
    const module = `
      export function activate(api) {
        api.registerCommand({ id: "code", title: "Write Code", execute() { return api.code.write("code/blocked.js", "blocked"); } });
        api.registerCommand({ id: "asset", title: "Create Asset", execute() { return api.assets.create("assets/blocked.hasset", { type: "Class", name: "Blocked", payload: { nodes: [], edges: [] } }); } });
        api.registerCommand({ id: "read", title: "Read", execute() { api.log("Read-only command ran"); } });
      }
    `;
    await writeProjectExtension(project, "tools", enabledSettings("tools"), module);
    await service.refresh();
    const lease = admission.lock("Project is read-only");
    expect(await lease.ready).toBe(true);
    try {
      await expect(service.run("tools", "code", {})).rejects.toThrow(/read-only/);
      await expect(service.run("tools", "asset", {})).rejects.toThrow(/read-only/);
      await expect(service.save("tools", enabledSettings("tools"), { write: [{ path: "index.ts", source: originalModule }], remove: [] })).rejects.toThrow(/read-only/);
      await expect(service.remove("tools")).rejects.toThrow(/read-only/);
      await service.run("tools", "read", {});
      expect(messages).toContain("Read-only command ran");
      expect(await project.exists("code/blocked.js")).toBe(false);
      expect(await project.exists("assets/blocked.hasset")).toBe(false);
      expect(await project.readText("extensions/tools/index.ts")).toBe(module);
    } finally { lease.release(); }
    await service.run("tools", "code", {});
    expect(await project.readText("code/blocked.js")).toBe("blocked");
  });

  it("publishes commands registered and removed by an active extension callback", async () => {
    const { project, service, messages } = await fixture();
    let updateCommands!: () => void;
    vi.stubGlobal("__extensionUpdateCommands", (callback: () => void) => { updateCommands = callback; });
    await writeProjectExtension(project, "tools", enabledSettings("tools"), `
      export function activate(api) {
        const removeOriginal = api.registerCommand({ id: "original", title: "Original", execute() {} });
        globalThis.__extensionUpdateCommands(() => {
          removeOriginal();
          api.registerCommand({ id: "replacement", title: "Replacement", execute() { api.log("Replacement Worked"); } });
        });
      }
    `);
    await service.refresh();
    const observed: string[][] = [];
    const unsubscribe = service.subscribe(() => { observed.push(service.getSnapshot().commands.map((command) => command.id)); });

    updateCommands();

    expect(service.getSnapshot().commands.map((command) => command.id)).toEqual(["replacement"]);
    expect(observed).toContainEqual(["replacement"]);
    await expect(service.run("tools", "original", {})).rejects.toThrow(/unavailable/);
    await service.run("tools", "replacement", {});
    expect(messages).toContain("Replacement Worked");
    unsubscribe();
  });

  it("publishes command failures immediately and clears them on retry without losing package diagnostics", async () => {
    const { project, service } = await fixture();
    await project.mkdir("extensions/broken", true);
    await project.writeText("extensions/broken/extension.json", "{}");
    await writeProjectExtension(project, "tools", enabledSettings("tools"), `
      export function activate(api) {
        api.registerCommand({ id: "write", title: "Write", execute(values) {
          if (values.source === "bad") throw new Error("Invalid source");
          return api.code.write("code/output.js", values.source);
        } });
      }
    `);
    await service.refresh();
    const packageDiagnostics = service.getSnapshot().diagnostics;
    expect(packageDiagnostics.length).toBeGreaterThan(0);

    await expect(service.run("tools", "write", { source: "bad" })).rejects.toThrow("Invalid source");
    expect(service.getSnapshot().diagnostics).toContain("Invalid source");
    await service.refresh();
    await service.run("tools", "write", { source: "export const ready = true;" });

    expect(service.getSnapshot().diagnostics).toEqual(packageDiagnostics);
    expect(await project.readText("code/output.js")).toBe("export const ready = true;");
  });

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

  it("retries a transient activation failure without restarting extensions that already started", async () => {
    const { project, service, messages } = await fixture();
    await writeProjectExtension(project, "steady", enabledSettings("steady"), `
      export function activate(api) {
        api.log("Steady Started");
        return () => api.log("Steady Stopped");
      }
    `);
    await writeProjectExtension(project, "tools", enabledSettings("tools"), `
      export async function activate(api) {
        await api.code.read("code/ready.ts");
        api.registerCommand({ id: "run", title: "Run", execute() { api.log("Ready"); } });
      }
    `);

    await service.refresh();
    expect(service.getSnapshot().commands).toEqual([]);
    expect(service.getSnapshot().diagnostics.length).toBeGreaterThan(0);

    await service.refresh();
    await project.mkdir("code", true);
    await project.writeText("code/ready.ts", "export const ready = true;");
    await service.refresh();

    expect(service.getSnapshot().commands).toMatchObject([{ extensionId: "tools", id: "run" }]);
    expect(service.getSnapshot().diagnostics).toEqual([]);
    await service.run("tools", "run", {});
    expect(messages).toEqual(["Steady Started", "Ready"]);
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

describe("EditorExtensionService code files and gameplay packages", () => {
  async function gameplayPackage(project: Awaited<ReturnType<typeof storage>>, guid: string, game: string, extra: Partial<ExtensionSettings> = {}, files: Record<string, string> = {}) {
    await writeProjectExtension(project, guid, enabledSettings(guid, { editorOnly: false, libraryName: guid, ...extra }), "export function activate() {}");
    await project.writeText(`extensions/${guid}/game.ts`, game);
    for (const [path, source] of Object.entries(files)) {
      await project.mkdir(`extensions/${guid}/${path.slice(0, path.lastIndexOf("/"))}`, true);
      await project.writeText(`extensions/${guid}/${path}`, source);
    }
  }

  it("saves new code files under code/, links them from the entry and deletes removed ones", async () => {
    const { project, service } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();
    const linked = `
      import { title } from "./code/title";
      export function activate(api) { api.registerCommand({ id: "run", title, execute() {} }); }
    `;

    await service.save("tools", enabledSettings("tools"), { write: [
      { path: "index.ts", source: linked },
      { path: "code/title.ts", source: "export const title = 'Linked Title';" },
    ], remove: [] });

    expect(await project.readText("extensions/tools/code/title.ts")).toBe("export const title = 'Linked Title';");
    expect(service.getSnapshot().commands.map((command) => command.title)).toEqual(["Linked Title"]);
    expect((await service.readFiles("tools")).map((file) => file.path)).toEqual(["code/title.ts", "index.ts"]);
    await expect(service.save("tools", enabledSettings("tools"), { write: [{ path: "lib/other.ts", source: "" }], remove: [] }))
      .rejects.toThrow(/New Extension code files go in code\//);
    await expect(service.save("tools", enabledSettings("tools"), { write: [], remove: ["index.ts"] })).rejects.toThrow(/entry files/);
    expect(await project.exists("extensions/tools/lib/other.ts")).toBe(false);

    await service.save("tools", enabledSettings("tools"), { write: [{ path: "index.ts", source: originalModule }], remove: ["code/title.ts"] });

    expect(await project.exists("extensions/tools/code/title.ts")).toBe(false);
    expect(service.getSnapshot().commands.map((command) => command.title)).toEqual(["Run Original"]);
  });

  it("refuses to make a package gameplay without its game entry", async () => {
    const { project, service } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();

    await expect(service.save("tools", enabledSettings("tools", { editorOnly: false }), { write: [], remove: [] })).rejects.toThrow(/game entry: game.ts/);

    expect((await service.readFiles("tools")).map((file) => file.path)).toEqual(["index.ts"]);
    expect(service.getSnapshot().entries[0]?.settings.editorOnly).toBe(true);
  });

  it("links enabled gameplay libraries dependencies first, leaving out Editor Only and disabled packages", async () => {
    const { project, service } = await fixture();
    await gameplayPackage(project, "weather", "import { rain } from './code/rain';\nexport const forecast = (value) => rain(extensions.base.double(value));", {
      extensionDependencies: [{ guid: "base", version: "1.0.0" }],
    }, { "code/rain.ts": "export const rain = (value: number): string => `${value} mm`;" });
    await gameplayPackage(project, "base", "export const double = (value) => value * 2;");
    await gameplayPackage(project, "off", "export const off = true;", { enabledByDefault: false });
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await project.writeText("extensions/tools/game.ts", "export const editorOnly = true;");
    await service.refresh();

    const libraries = await service.gameLibraries();

    expect(libraries.map((library) => library.libraryName)).toEqual(["base", "weather"]);
    expect(service.getGameplayExtensions().map((entry) => entry.extensionGuid)).toEqual(["base", "weather"]);
    const extensions = loadExtensionGameLibraries(libraries);
    expect((extensions.weather!.forecast as (value: number) => string)(3)).toBe("6 mm");
    expect((await service.gameLibraries({ off: { enabled: true } })).map((library) => library.libraryName)).toEqual(["base", "off", "weather"]);
  });

  it("rejects two enabled gameplay packages that claim one Library Name", async () => {
    const { project, service } = await fixture();
    await gameplayPackage(project, "first", "export const a = 1;", { libraryName: "shared" });
    await gameplayPackage(project, "second", "export const b = 2;", { libraryName: "shared" });
    await service.refresh();

    expect(service.getSnapshot().diagnostics).toContain("Library Name shared is used by first, second.");
    await expect(service.gameLibraries()).rejects.toThrow("Library Name shared is used by first, second.");
  });

  it("mounts a package's content once it turns gameplay and releases it before deleting its files", async () => {
    const synced: { guids: string[]; folderExists: boolean }[] = [];
    let project!: Awaited<ReturnType<typeof storage>>;
    const fixtureResult = await fixture({
      syncContentRoots: async (extensions) => {
        synced.push({ guids: extensions.map((entry) => entry.extensionGuid), folderExists: await project.exists("extensions/tools") });
      },
    });
    project = fixtureResult.project;
    const { service } = fixtureResult;
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();
    expect(synced).toEqual([]);

    await service.save("tools", enabledSettings("tools", { editorOnly: false }), { write: [{ path: "game.ts", source: "export const ready = true;" }], remove: [] });
    expect(synced).toEqual([{ guids: ["tools"], folderExists: true }]);
    await service.refresh();
    expect(synced).toHaveLength(1);

    await service.remove("tools");
    expect(synced).toEqual([{ guids: ["tools"], folderExists: true }, { guids: [], folderExists: true }]);
    expect(await project.exists("extensions/tools")).toBe(false);
  });
});
