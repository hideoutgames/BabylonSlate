import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionSettings,
  decodeAssetDocument,
  encodeAssetDocument,
  exportExtensionZip,
  normalizeExtensionContributions,
  writeProjectExtension,
  type ExtensionSettings,
} from "@haptic/assets";
import { loadExtensionGameLibraries } from "@haptic/core";
import { convertGlslToMaterial } from "@haptic/shader-graph";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { EditorExtensionService, type EditorExtensionWriteOptions } from "./editor-extension-service";
import { ProjectWriteAdmission } from "./project-write-admission";

/** Play in the web editor. */
const WEB_PLAY = { platform: "web", editor: true } as const;
/** What Play and packaging report for Execute JavaScript in `assets`. */
const javaScriptIn = (...assets: string[]) => [{ kind: "executeJavaScript" as const, title: "Execute JavaScript", assets }];

const activeServices: EditorExtensionService[] = [];

async function storage(name = "project") {
  const result = new MemoryStorageAdapter("documents");
  await result.openDocumentsProject(name);
  return result;
}

async function fixture(options?: EditorExtensionWriteOptions, listed: { path: string; type: string; name: string; guid: string }[] = []) {
  const project = await storage();
  const messages: string[] = [];
  const service = new EditorExtensionService(project, {
    assets: {
      list: async () => listed,
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
  // This computer trusts the test project; later refreshes keep that unless a test changes it.
  await service.refresh({}, true);
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
        api.registerCommand({ id: "write", title: "Write", fields: [{ id: "source", label: "Source", type: "text" }], execute(values) {
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

    const libraries = await service.gameLibraries(WEB_PLAY);

    expect(libraries.map((library) => library.libraryName)).toEqual(["base", "weather"]);
    expect(service.getGameplayExtensions().map((entry) => entry.extensionGuid)).toEqual(["base", "weather"]);
    const extensions = loadExtensionGameLibraries(libraries);
    expect((extensions.weather!.forecast as (value: number) => string)(3)).toBe("6 mm");
    expect((await service.gameLibraries(WEB_PLAY, { off: { enabled: true } })).map((library) => library.libraryName)).toEqual(["base", "off", "weather"]);
  });

  it("links game code with the platform directives of the platform it is played or packaged for", async () => {
    const { project, service } = await fixture();
    await gameplayPackage(project, "presence", [
      "// #if WITH_DESKTOP",
      "import { connect } from './code/desktop';",
      "// #endif",
      "export function where(): string {",
      "  // #if WITH_DESKTOP && WITH_EDITOR",
      "  return connect('desktop play');",
      "  // #elif WITH_DESKTOP",
      "  return connect('desktop game');",
      "  // #else",
      "  return 'elsewhere';",
      "  // #endif",
      "}",
    ].join("\n"), {}, { "code/desktop.ts": "export const connect = (where: string): string => `connected in ${where}`;" });
    await service.refresh();

    const where = async (target: { platform: "web" | "windows" | "android"; editor: boolean }) => {
      const [library] = await service.gameLibraries(target);
      return { result: (loadExtensionGameLibraries([library!]).presence!.where as () => string)(), modules: library!.bundle.modules.map((module) => module.path) };
    };
    expect(await where({ platform: "windows", editor: true })).toEqual({ result: "connected in desktop play", modules: ["game.ts", "code/desktop.ts"] });
    expect(await where({ platform: "windows", editor: false })).toEqual({ result: "connected in desktop game", modules: ["game.ts", "code/desktop.ts"] });
    // The desktop file is never linked, so it never ships in a web or mobile game.
    expect(await where({ platform: "web", editor: false })).toEqual({ result: "elsewhere", modules: ["game.ts"] });
    expect(await where({ platform: "android", editor: true })).toEqual({ result: "elsewhere", modules: ["game.ts"] });
  });

  it("names the file and line of a malformed platform directive in game code", async () => {
    const { project, service } = await fixture();
    await gameplayPackage(project, "presence", "// #if WITH_DESKTOP\nexport const a = 1;\n");
    await service.refresh();
    await expect(service.gameLibraries(WEB_PLAY)).rejects.toThrow("Extension presence: game.ts:1: #if without #endif.");
  });

  it("links game libraries with their Project Settings values and tells running editor code when they change", async () => {
    const { project, service, messages } = await fixture();
    const contributes = normalizeExtensionContributions({ settings: { title: "Weather Setup", sections: [{ id: "general", title: "General", fields: [
      { id: "region", label: "Region", type: "text", default: "north" },
      { id: "scale", label: "Scale", type: "number", default: 1 },
    ] }] } });
    await gameplayPackage(project, "weather", "import { settings } from 'haptic:extension';\nexport const describe = () => `${settings.region}:${settings.scale}`;", { contributes });
    await project.writeText("extensions/weather/index.ts", "export function activate(api) { api.log(`Region ${api.settings.get().region}`); api.settings.onChange((values) => api.log(`Region ${values.region}`)); }");
    service.setSettingValues({ weather: { region: "west" } });
    await service.refresh();

    const [library] = await service.gameLibraries(WEB_PLAY);
    expect(library!.settings).toEqual({ region: "west", scale: 1 });
    expect((loadExtensionGameLibraries([library!]).weather!.describe as () => string)()).toBe("west:1");
    const [exported] = await service.gameLibraries(WEB_PLAY, {}, { weather: { scale: 3 } });
    expect(exported!.settings).toEqual({ region: "north", scale: 3 });

    service.setSettingValues({ weather: { region: "south" } });
    expect(messages).toEqual(["Region west", "Region south"]);
  });

  it("publishes enabled asset types and links the project's assets of gameplay types into their library", async () => {
    const preset = "extension.weather.preset";
    const listed = [
      { path: "assets/Rain.hasset", type: preset, name: "Rain", guid: "rain-guid" },
      { path: "assets/Notes.hasset", type: "extension.weather.notes", name: "Notes", guid: "notes-guid" },
      { path: "assets/Dry.hasset", type: preset, name: "Dry", guid: "dry-guid" },
      { path: "assets/Other.hasset", type: "extension.other.preset", name: "Other", guid: "other-guid" },
    ];
    const { project, service } = await fixture(undefined, listed);
    const field = (id: string) => [{ id: "main", title: "Main", fields: [{ id, label: "Value", type: "number", max: 10 }] }];
    await gameplayPackage(project, "weather", "import { assets } from 'haptic:extension';\nexport const wettest = () => Math.max(...assets.list('preset').map((asset) => asset.values.rain));", {
      contributes: normalizeExtensionContributions({ assetTypes: [
        { id: "preset", title: "Weather Preset", editorOnly: false, sections: field("rain") },
        { id: "notes", title: "Weather Notes", sections: field("lines") },
      ] }),
    });
    for (const [path, type, payload] of [
      ["assets/Rain.hasset", preset, { rain: 25, stray: true }],
      ["assets/Dry.hasset", preset, {}],
      ["assets/Notes.hasset", "extension.weather.notes", { lines: 2 }],
    ] as const) {
      await project.mkdir("assets", true);
      await project.writeBinary(path, await encodeAssetDocument({ type, name: path, guid: path, version: 0, payload }));
    }
    await service.refresh();

    expect(service.getSnapshot().assetTypes.map((type) => [type.type, type.title, type.category, type.editorOnly])).toEqual([
      [preset, "Weather Preset", "weather", false],
      ["extension.weather.notes", "Weather Notes", "weather", true],
    ]);
    const [library] = await service.gameLibraries(WEB_PLAY);
    // Path order; values resolved against the fields (clamped, unknown keys dropped); Editor Only and other extensions' types left out.
    expect(library!.assets).toEqual([
      { guid: "dry-guid", name: "Dry", type: "preset", values: { rain: 0 } },
      { guid: "rain-guid", name: "Rain", type: "preset", values: { rain: 10 } },
    ]);
    expect((loadExtensionGameLibraries([library!]).weather!.wettest as () => number)()).toBe(10);
    const [playing] = await service.gameLibraries(WEB_PLAY, undefined, undefined, (path) => path === "assets/Rain.hasset" ? { rain: 4 } : undefined);
    expect(playing!.assets.map((asset) => asset.values.rain)).toEqual([0, 4]);
  });

  it("flags gameplay asset types of an Editor Only package, which has no game library to carry them", async () => {
    const { project, service } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools", {
      contributes: normalizeExtensionContributions({ assetTypes: [
        { id: "preset", title: "Preset", editorOnly: false, sections: [{ id: "s", title: "S", fields: [{ id: "x", label: "X", type: "text" }] }] },
      ] }),
    }), originalModule);
    await service.refresh();

    expect(service.getSnapshot().assetTypes.map((type) => type.type)).toEqual(["extension.tools.preset"]);
    expect(service.getSnapshot().diagnostics).toContain("tools: its gameplay asset types reach games only while Editor Only is off.");
  });

  it("rejects two enabled gameplay packages that claim one Library Name", async () => {
    const { project, service } = await fixture();
    await gameplayPackage(project, "first", "export const a = 1;", { libraryName: "shared" });
    await gameplayPackage(project, "second", "export const b = 2;", { libraryName: "shared" });
    await service.refresh();

    expect(service.getSnapshot().diagnostics).toContain("Library Name shared is used by first, second.");
    await expect(service.gameLibraries(WEB_PLAY)).rejects.toThrow("Library Name shared is used by first, second.");
  });

  it("mounts a package's content once it turns gameplay and releases it before deleting its files", async () => {
    const synced: { guids: string[]; folderExists: boolean }[] = [];
    const created: { project?: Awaited<ReturnType<typeof storage>> } = {};
    const { project, service } = await fixture({
      syncContentRoots: async (extensions) => {
        synced.push({ guids: extensions.map((entry) => entry.extensionGuid), folderExists: await created.project!.exists("extensions/tools") });
      },
    });
    created.project = project;
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

describe("EditorExtensionService Workspace Trust", () => {
  it("runs no Project Extension of an untrusted project, in the editor or in Play, until it is trusted", async () => {
    const { project, service, messages } = await fixture();
    const started = vi.fn();
    vi.stubGlobal("__extensionStarted", started);
    await writeProjectExtension(project, "tools", enabledSettings("tools", { editorOnly: false, libraryName: "tools" }), `
      export function activate(api) {
        globalThis.__extensionStarted();
        api.registerCommand({ id: "run", title: "Run", execute() { api.log("ran"); } });
      }
    `);
    await project.writeText("extensions/tools/game.ts", "globalThis.__extensionStarted(); export const ready = true;");

    await service.refresh({}, false);

    expect(started).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({ trusted: false, untrusted: ["tools"], commands: [] });
    // Listed, so the user can see and trust it, but never linked into Play, Preview Build or a package.
    expect(service.getSnapshot().entries.map((entry) => entry.extensionGuid)).toEqual(["tools"]);
    await expect(service.gameLibraries(WEB_PLAY)).rejects.toThrow("Project Extensions are not trusted on this computer, so tools cannot run.");
    await expect(service.run("tools", "run", {})).rejects.toThrow();
    expect(messages).toEqual([]);

    await service.refresh(undefined, true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot()).toMatchObject({ trusted: true, untrusted: [] });
    expect((await service.gameLibraries(WEB_PLAY)).map((library) => library.libraryName)).toEqual(["tools"]);

    // Revoking trust stops what runs and keeps it stopped through later refreshes.
    await service.refresh(undefined, false);
    expect(service.getSnapshot().commands).toEqual([]);
    await service.refresh();
    expect(service.getSnapshot()).toMatchObject({ trusted: false, untrusted: ["tools"], commands: [] });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("refuses trust-gated nodes until the project is trusted, naming them for the trust prompt", async () => {
    const { service } = await fixture();
    await service.refresh({}, false);
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero", "Level 1"))).toThrow(
      "This project is not trusted on this computer, so the Execute JavaScript in Hero and Level 1 cannot run.");
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Boss"))).toThrow("Execute JavaScript in Boss cannot run.");
    expect(service.getSnapshot()).toMatchObject({ untrustedNodes: [{ kind: "executeJavaScript", title: "Execute JavaScript", assets: ["Boss", "Hero", "Level 1"] }], trustRefusals: 2 });
    // Open URL and Extension nodes are refused the same way, in one message naming each, and join the prompt's list.
    // An Extension node titled like a built-in node stays an Extension node, named as one.
    expect(() => service.assertTrustGatedNodesAllowed([
      { kind: "executeJavaScript", title: "Execute JavaScript", assets: ["Hero"] },
      { kind: "openUrl", title: "Open URL", assets: ["Menu", "Hero"] },
      { kind: "extension", title: "Open URL", assets: ["Shop"] },
      { kind: "extension", title: "Start Discord Rich Presence", assets: ["Game"] },
    ])).toThrow("so the Execute JavaScript in Hero; the Open URL in Menu and Hero; the Extension node Open URL in Shop; "
      + "the Extension node Start Discord Rich Presence in Game cannot run.");
    expect(service.getSnapshot()).toMatchObject({ untrustedNodes: [
      { kind: "executeJavaScript", title: "Execute JavaScript", assets: ["Boss", "Hero", "Level 1"] },
      { kind: "openUrl", title: "Open URL", assets: ["Hero", "Menu"] },
      { kind: "extension", title: "Open URL", assets: ["Shop"] },
      { kind: "extension", title: "Start Discord Rich Presence", assets: ["Game"] },
    ], trustRefusals: 3 });
    // Nothing to refuse without a trust-gated node.
    expect(() => service.assertTrustGatedNodesAllowed([])).not.toThrow();

    // Trusting lifts the refusal at once, with no reload, and clears the prompt's list.
    await service.refresh(undefined, true);
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).not.toThrow();
    expect(service.getSnapshot().untrustedNodes).toEqual([]);

    await service.refresh(undefined, false);
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).toThrow("Execute JavaScript in Hero cannot run.");
    await service.close();
    expect(service.getSnapshot().untrustedNodes).toEqual([]);
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).toThrow("Execute JavaScript in Hero cannot run.");
  });

  it("reads trust for trust-gated nodes when it checks, so neither a grant nor a revoke waits for a refresh", async () => {
    const { service } = await fixture();
    let settingsTrust = false;
    await service.refresh({}, false);
    service.setTrustSource(() => settingsTrust);
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).toThrow("Execute JavaScript in Hero cannot run.");

    // Trust, then Play before any refresh: the settings already record it.
    settingsTrust = true;
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).not.toThrow();

    // Revoke, then Play before the settings write lands, and with a refresh queued earlier carrying the old trust.
    const stale = service.refresh(undefined, true);
    service.revokeTrust();
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).toThrow("Execute JavaScript in Hero cannot run.");
    await stale;
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).toThrow("Execute JavaScript in Hero cannot run.");

    // A later grant the settings record lifts it.
    service.clearRevocation();
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).not.toThrow();

    // Closing ends trust at once, before the queue reaches the close.
    service.setTrustSource(null);
    await service.refresh(undefined, true);
    const closing = service.close();
    expect(() => service.assertTrustGatedNodesAllowed(javaScriptIn("Hero"))).toThrow("Execute JavaScript in Hero cannot run.");
    await closing;
  });

  it("forgets trust when the project closes", async () => {
    const { project, service } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await service.refresh();
    expect(service.getSnapshot().commands).toHaveLength(1);

    await service.close();
    await service.refresh();

    expect(service.getSnapshot()).toMatchObject({ trusted: false, untrusted: ["tools"], commands: [] });
  });

  it("keys trust by the project's folder and GUID, and trusts without asking only a project created here", async () => {
    const { project, service } = await fixture();
    const key = service.projectTrustKey("guid-a");
    expect(key).toBe(JSON.stringify([project.getCurrentFolder()!.id, "guid-a"]));
    expect(service.projectTrustKey("guid-b")).not.toBe(key);
    expect(service.createdHere(key!)).toBe(false);

    service.noteCreatedProject("guid-a");
    expect(service.createdHere(key!)).toBe(true);
    expect(service.createdHere(service.projectTrustKey("guid-b")!)).toBe(false);
    service.forgetCreatedProject();
    expect(service.createdHere(key!)).toBe(false);
  });
});

describe("EditorExtensionService save rollback", () => {
  it("restores every other file when one restore fails and reports both failures", async () => {
    const { project, service } = await fixture();
    await writeProjectExtension(project, "tools", enabledSettings("tools"), originalModule);
    await project.mkdir("extensions/tools/code", true);
    await project.writeText("extensions/tools/code/a.ts", "export const a = 1;");
    await project.writeText("extensions/tools/code/b.ts", "export const b = 1;");
    await service.refresh();
    const writeText = project.writeText.bind(project);
    vi.spyOn(project, "writeText").mockImplementation(async (path, data) => {
      // The save writes a.ts and b.ts, then fails on c.ts; restoring a.ts fails too.
      if (path === "extensions/tools/code/c.ts") throw new Error("disk full");
      if (path === "extensions/tools/code/a.ts" && data === "export const a = 1;") throw new Error("a.ts is locked");
      return writeText(path, data);
    });

    const saving = service.save("tools", enabledSettings("tools"), { write: [
      { path: "code/a.ts", source: "export const a = 2;" },
      { path: "code/b.ts", source: "export const b = 2;" },
      { path: "code/c.ts", source: "export const c = 2;" },
    ], remove: [] });

    await expect(saving).rejects.toThrow("disk full Some files could not be restored: code/a.ts: a.ts is locked");
    // b.ts comes back although a.ts, restored before it, failed.
    expect(await project.readText("extensions/tools/code/b.ts")).toBe("export const b = 1;");
    expect(await project.exists("extensions/tools/code/c.ts")).toBe(false);
  });
});
