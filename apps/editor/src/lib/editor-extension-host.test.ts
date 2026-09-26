import type { AssetDocument } from "@babylonslate/assets";
import { convertGlslToMaterial } from "@babylonslate/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorExtensionHost, type EditorExtensionApi, type EditorExtensionServices } from "./editor-extension-host";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const assets = new Map<string, AssetDocument>([["Content/Original.babasset", {
    type: "Material", name: "Original", guid: "original-guid", version: 1, payload: { roughness: 0.5 },
  }]]);
  const code = new Map([["Code/game.ts", "export const speed = 1;"]]);
  const services: EditorExtensionServices = {
    assets: {
      list: async () => [...assets].map(([path, document]) => ({ path, type: document.type, name: document.name, guid: document.guid })),
      read: async (path) => {
        const document = assets.get(path);
        if (!document) throw new Error(`Missing asset: ${path}`);
        return structuredClone(document);
      },
      create: async (path, document) => {
        if (assets.has(path)) throw new Error(`Asset exists: ${path}`);
        assets.set(path, { ...structuredClone(document), guid: "new-guid", version: 1 });
      },
      update: async (path, document) => {
        if (!assets.has(path)) throw new Error(`Missing asset: ${path}`);
        assets.set(path, structuredClone(document));
      },
    },
    code: {
      read: async (path) => code.get(path) ?? "",
      write: async (path, source) => { code.set(path, source); },
    },
    materials: { convertGlsl: convertGlslToMaterial },
  };
  return { assets, code, services, host: new EditorExtensionHost(services) };
}

afterEach(() => vi.unstubAllGlobals());

describe("EditorExtensionHost", () => {
  it("runs an ESM JavaScript extension against asset and project-code APIs", async () => {
    const { host, assets, code } = fixture();
    expect(await host.activate({ id: "asset-tools", path: "index.js", source: `
      export function activate(api) {
        api.registerCommand({ id: "edit", title: "Edit Assets", execute: async () => {
          const [entry] = await api.assets.list();
          const document = await api.assets.read(entry.path);
          document.payload.roughness = 0.8;
          await api.assets.update(entry.path, document);
          await api.assets.create("Content/Copy.babasset", { type: document.type, name: "Copy", payload: document.payload });
          const source = await api.code.read("Code/game.ts");
          await api.code.write("Code/game.ts", source.replace("1", "2"));
        }});
      }
    ` })).toBe(true);

    await host.run("asset-tools", "edit");

    expect(assets.get("Content/Original.babasset")?.payload).toEqual({ roughness: 0.8 });
    expect(assets.get("Content/Copy.babasset")).toEqual({
      type: "Material", name: "Copy", guid: "new-guid", version: 1, payload: { roughness: 0.8 },
    });
    expect(code.get("Code/game.ts")).toBe("export const speed = 2;");
    expect(host.getDiagnostics()).toEqual([]);
  });

  it("transpiles typed TypeScript and supplies command defaults and conversion options", async () => {
    const { host, assets } = fixture();
    expect(await host.activate({ id: "convert", path: "entry.ts", source: `
      type Values = Record<string, string>;
      export function activate(api: {
        registerCommand(command: { id: string; title: string; fields: object[]; execute: (values: Values) => Promise<void> }): void;
        materials: { convertGlsl(source: string, options: object): Promise<Record<string, unknown>> };
        assets: { create(path: string, document: object): Promise<void> };
      }): void {
        api.registerCommand({ id: "convert", title: "Convert", fields: [
          { id: "source", label: "GLSL Source", type: "multiline", required: true },
          { id: "name", label: "Name", type: "text", defaultValue: "Converted" },
        ], execute: async (values: Values): Promise<void> => {
          const result = await api.materials.convertGlsl(values.source, { name: values.name, bindings: { uTime: "time" } });
          if (!result.ok) throw new Error("Conversion failed");
          await api.assets.create("Content/Converted.babasset", { type: "Material", name: values.name, payload: result.document });
        }});
      }
    ` })).toBe(true);

    await expect(host.run("convert", "convert", { source: " " })).rejects.toThrow(/required/i);
    expect(assets.has("Content/Converted.babasset")).toBe(false);
    await host.run("convert", "convert", { source: "uniform float uTime; void main() { gl_FragColor = vec4(uTime); }" });

    expect(assets.get("Content/Converted.babasset")?.payload).toMatchObject({ name: "Converted" });
    expect(assets.get("Content/Converted.babasset")?.payload.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "input.time" }),
    ]));
  });

  it.each([
    ["import", "import './other.js'; export function activate() {}"],
    ["re-export", "export { activate } from './other.js';"],
    ["require", "const other = require('./other.js'); exports.activate = other.activate;"],
    ["dynamic import", "export function activate() { return import('./other.js'); }"],
    ["syntax error", "export function activate( {"],
    ["missing activate", "export const description = 'No entry point';"],
  ])("reports %s entry failure without losing a different extension", async (_name, source) => {
    const { host, code } = fixture();
    await host.activate({ id: "healthy", path: "healthy.js", source: `
      module.exports = { activate(api) {
        api.registerCommand({ id: "write", title: "Write", execute() { return api.code.write("Code/healthy.js", "ok"); } });
      }};
    ` });

    expect(await host.activate({ id: "broken", path: "broken.js", source })).toBe(false);
    expect(host.getDiagnostics()).toEqual([expect.objectContaining({ extensionId: "broken", phase: "activate" })]);
    await host.run("healthy", "write");
    expect(code.get("Code/healthy.js")).toBe("ok");
  });

  it("removes partial commands after failed activation and allows a repaired activation", async () => {
    const { host } = fixture();
    expect(await host.activate({ id: "tools", path: "tools.js", source: `
      export function activate(api) {
        api.registerCommand({ id: "partial", title: "Partial", execute() {} });
        throw new Error("Could not initialize");
      }
    ` })).toBe(false);
    expect(host.listCommands()).toEqual([]);
    await expect(host.run("tools", "partial")).rejects.toThrow(/unavailable/i);

    expect(await host.activate({ id: "tools", path: "tools.js", source: `
      export function activate(api) {
        api.registerCommand({ id: "fixed", title: "Fixed", execute() {} });
      }
    ` })).toBe(true);
    await expect(host.run("tools", "fixed")).resolves.toBeUndefined();
  });

  it("disposes a replaced extension before activating its replacement and cleans up once", async () => {
    const { host } = fixture();
    const events: string[] = [];
    vi.stubGlobal("__extensionHostEvents", events);
    await host.activate({ id: "tools", path: "tools.js", source: `
      export function activate(api) {
        api.registerCommand({ id: "old", title: "Old", execute() {} });
        return () => globalThis.__extensionHostEvents.push("old disposed");
      }
    ` });
    await host.activate({ id: "tools", path: "tools.js", source: `
      export function activate(api) {
        globalThis.__extensionHostEvents.push("new activated");
        api.registerCommand({ id: "new", title: "New", execute() {} });
        return () => globalThis.__extensionHostEvents.push("new disposed");
      }
    ` });

    await expect(host.run("tools", "old")).rejects.toThrow(/unavailable/i);
    await host.deactivate("tools");
    await host.dispose();
    expect(events).toEqual(["old disposed", "new activated", "new disposed"]);
    expect(host.listCommands()).toEqual([]);
  });

  it("rejects an in-flight command after disable before it can write project code", async () => {
    const { host, services, code } = fixture();
    const read = deferred<string>();
    const started = deferred<void>();
    let capturedApi!: EditorExtensionApi;
    vi.stubGlobal("__extensionHostCapture", (api: EditorExtensionApi) => { capturedApi = api; });
    services.code.read = () => { started.resolve(); return read.promise; };
    await host.activate({ id: "slow", path: "slow.js", source: `
      export function activate(api) {
        globalThis.__extensionHostCapture(api);
        api.registerCommand({ id: "write", title: "Write", execute: async () => {
          const source = await api.code.read("Code/game.ts");
          await api.code.write("Code/game.ts", source + " stale edit");
        }});
      }
    ` });

    const run = host.run("slow", "write");
    await started.promise;
    await host.deactivate("slow");
    await expect(capturedApi.code.write("Code/game.ts", "late write")).rejects.toThrow(/no longer active/i);
    read.resolve("changed");

    await expect(run).rejects.toThrow(/no longer active/i);
    expect(code.get("Code/game.ts")).toBe("export const speed = 1;");
    expect(host.listCommands()).toEqual([]);
  });

  it("cleans up late activation without restoring commands after host disposal", async () => {
    const { host } = fixture();
    const gate = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    vi.stubGlobal("__extensionHostGate", gate.promise);
    vi.stubGlobal("__extensionHostStarted", started.resolve);
    vi.stubGlobal("__extensionHostEvents", events);
    const activation = host.activate({ id: "slow", path: "slow.js", source: `
      export async function activate(api) {
        api.registerCommand({ id: "pending", title: "Pending", execute() {} });
        globalThis.__extensionHostStarted();
        await globalThis.__extensionHostGate;
        return () => globalThis.__extensionHostEvents.push("disposed");
      }
    ` });
    await started.promise;
    expect(host.listCommands()).toEqual([]);
    await host.dispose();
    gate.resolve();

    expect(await activation).toBe(false);
    expect(events).toEqual(["disposed"]);
    expect(host.listCommands()).toEqual([]);
    await expect(host.activate({ id: "later", path: "later.js", source: "" })).rejects.toThrow(/disposed/i);
  });

  it("keeps a command available for corrected input after reporting an execution error", async () => {
    const { host, code } = fixture();
    await host.activate({ id: "validate", path: "validate.js", source: `
      export function activate(api) {
        api.registerCommand({ id: "save", title: "Save", execute(values) {
          if (values.source === "bad") throw new Error("Invalid source");
          return api.code.write("Code/output.js", values.source);
        }});
      }
    ` });

    await expect(host.run("validate", "save", { source: "bad" })).rejects.toThrow("Invalid source");
    expect(host.getDiagnostics()).toEqual([expect.objectContaining({ extensionId: "validate", phase: "command" })]);
    await host.run("validate", "save", { source: "valid" });

    expect(code.get("Code/output.js")).toBe("valid");
    expect(host.getDiagnostics()).toEqual([]);
  });

  it("continues disposal after one extension cleanup throws", async () => {
    const { host } = fixture();
    const events: string[] = [];
    vi.stubGlobal("__extensionHostEvents", events);
    await host.activate({ id: "healthy", path: "healthy.js", source: `
      export function activate() { return () => globalThis.__extensionHostEvents.push("cleaned"); }
    ` });
    await host.activate({ id: "broken", path: "broken.js", source: `
      export function activate(api) {
        api.registerCommand({ id: "action", title: "Action", execute() {} });
        return () => { throw new Error("Cleanup failed"); };
      }
    ` });

    await host.dispose();

    expect(events).toEqual(["cleaned"]);
    expect(host.listCommands()).toEqual([]);
    expect(host.getDiagnostics()).toEqual([expect.objectContaining({ extensionId: "broken", phase: "dispose" })]);
  });
});
