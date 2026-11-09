import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, loadExtensionGameLibraries, normalizeProjectSettings, type BuildPlatform } from "@haptic/core";
import { createExtensionSettings, encodeAssetDocument, normalizeExtensionContributions, writeProjectExtension, type ExtensionDescriptor } from "@haptic/assets";
import { createEmptyProjectFiles } from "../../../../packages/assets/src/test-support/project-files";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { lowerMaterialDocument } from "@haptic/shader-graph";
import { ProjectService } from "./project-service";
import { defaultNodeRegistry } from "./graph-hydration";
import { ensureEngineExtensionStorage } from "../lib/engine-extensions";

/** Play in the web editor. */
const WEB_PLAY = { platform: "web", editor: true } as const;
const GLSL_TO_MATERIAL = "a1e00000-0000-4000-8000-000000000001";
const DISCORD_RICH_PRESENCE = "a1e00000-0000-4000-8000-000000000002";

async function setup() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Extensions");
  const service = new ProjectService(storage);
  service.setEngineExtensionStorage(await ensureEngineExtensionStorage());
  await service.loadCurrentProject();
  await service.extensions.refresh();
  const entries = service.extensions.getSnapshot().entries;
  return {
    storage,
    service,
    bundled: entries.find((entry) => entry.extensionGuid === GLSL_TO_MATERIAL)!,
    discord: entries.find((entry) => entry.extensionGuid === DISCORD_RICH_PRESENCE)!,
  };
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
    const entries = service.extensions.getSnapshot().entries;
    const entry = entries.find((candidate) => candidate.extensionGuid === GLSL_TO_MATERIAL)!;
    const discord = entries.find((candidate) => candidate.extensionGuid === DISCORD_RICH_PRESENCE)!;
    expect([entry.source, discord.source]).toEqual(["project", "project"]);
    expect(await storage.exists(`${entry.folderPath}/index.js`)).toBe(true);
    expect([await storage.exists(`${discord.folderPath}/index.ts`), await storage.exists(`${discord.folderPath}/game.ts`)]).toEqual([true, true]);
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

describe("Discord Rich Presence", () => {
  const APPLICATION_ID = "123456789012345678";
  type Presence = Record<"start" | "update" | "clear", (...args: unknown[]) => Promise<Record<string, unknown>>>;
  afterEach(() => vi.unstubAllGlobals());

  async function presenceFor(target: { platform: BuildPlatform; editor: boolean }, applicationId = APPLICATION_ID) {
    const { service, discord } = await setup();
    await enable(service, discord);
    const [library] = await service.extensions.gameLibraries(target, { [discord.extensionGuid]: { enabled: true } }, { [discord.extensionGuid]: { applicationId } });
    return { service, library: library!, presence: loadExtensionGameLibraries([library!]).discordRichPresence as unknown as Presence };
  }

  it("is a disabled, experimental gameplay extension with a Discord settings category and three Game Instance nodes", async () => {
    const { service, discord } = await setup();
    expect(discord.settings).toMatchObject({
      displayName: "Discord Rich Presence", iconKey: "Discord", experimental: true, enabledByDefault: false, editorOnly: false, libraryName: "discordRichPresence",
    });
    expect(discord.settings.contributes.settings?.title).toBe("Discord");
    expect(discord.settings.contributes.settings?.sections.flatMap((section) => section.fields.map((field) => field.id))).toEqual(["applicationId"]);
    await enable(service, discord);
    const nodes = ["start", "update", "clear"].map((id) => defaultNodeRegistry().get(`extension.${DISCORD_RICH_PRESENCE}.${id}`));
    expect(nodes.map((node) => node?.title)).toEqual(["Start Discord Rich Presence", "Update Discord Rich Presence", "Clear Discord Rich Presence"]);
    expect(nodes.map((node) => node?.hosts)).toEqual([["GameInstance"], ["GameInstance"], ["GameInstance"]]);
    await service.closeProject();
  });

  it.each([
    [{ platform: "web", editor: true }],
    [{ platform: "android", editor: false }],
  ] as const)("leaves the Discord code out for %j, so its nodes report why they did nothing", async (target) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { service, library, presence } = await presenceFor(target);
    expect(library.bundle.modules.map((module) => module.code).join("\n")).not.toContain("discord-presence");
    const unavailable = "Discord Rich Presence works only in desktop games and Play in the desktop editor.";
    expect(await presence.start()).toEqual({ connected: false, error: unavailable });
    expect(await presence.update("Harbour Run", "", "", "", "", "", true, 0, 0)).toEqual({ updated: false, error: unavailable });
    expect(await presence.clear()).toEqual({ cleared: false, error: unavailable });
    expect(fetch).not.toHaveBeenCalled();
    await service.closeProject();
  });

  it("sends the presence to the desktop app on the game's own origin in desktop Play", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { origin: "app://babylonslate" });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { service, presence } = await presenceFor({ platform: "windows", editor: true });

    expect(await presence.start()).toEqual({ connected: true, error: "" });
    expect(await presence.update("Harbour Run", "Lap 2", "map", "Docks", "", "", true, 2, 4)).toEqual({ updated: true, error: "" });
    expect(await presence.clear()).toEqual({ cleared: true, error: "" });

    const calls = fetch.mock.calls as unknown as [URL, RequestInit][];
    expect(calls.map(([url]) => url.href)).toEqual(Array(3).fill("app://babylonslate/.haptic/discord-presence"));
    expect(calls.map(([, init]) => [init.method, (init.headers as Record<string, string>)["Content-Type"]])).toEqual(Array(3).fill(["POST", "application/json"]));
    expect(calls.map(([, init]) => JSON.parse(init.body as string))).toEqual([
      { applicationId: APPLICATION_ID, activity: null },
      { applicationId: APPLICATION_ID, activity: {
        details: "Harbour Run", state: "Lap 2", largeImage: "map", largeText: "Docks", smallImage: "", smallText: "", startTimestamp: 1_700_000_000_000, partySize: 2, partyMax: 4,
      } },
      { applicationId: APPLICATION_ID, activity: null },
    ]);
    await service.closeProject();
  });

  it("reports the desktop app's refusal and a missing Application ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "Discord is not running on this computer." }), { status: 503 })));
    vi.stubGlobal("location", { origin: "app://game" });
    const running = await presenceFor({ platform: "linux", editor: false });
    expect(await running.presence.start()).toEqual({ connected: false, error: "Discord is not running on this computer." });
    await running.service.closeProject();

    const unset = await presenceFor({ platform: "windows", editor: false }, "");
    expect(await unset.presence.start()).toEqual({ connected: false, error: "Set the Application ID in Project Settings > Discord." });
    await unset.service.closeProject();
  });
});
