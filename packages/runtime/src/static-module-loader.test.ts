import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compiledModuleBody, compiledScriptSourceLabel, createActor, writeGameScriptsModule, type ExtensionGameLibrary, type GameScriptsModule } from "@haptic/core";
import type { LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { createStaticModuleLoader } from "./static-module-loader";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Begin Play → Execute JavaScript (`value` 3 in, `result` out) → Log `result` in category Probe. */
function bodyGraph(body: string): LogicGraph {
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      graphNode(registry, "begin", "flow.event.beginPlay"),
      graphNode(registry, "js", "debug.executeJavaScript", {
        inputs: [{ name: "value", type: { kind: "float" } }],
        outputs: [{ name: "result", type: { kind: "string" } }],
        body,
        "default:in_value": 3,
      }),
      graphNode(registry, "log", "debug.log", { category: "Probe" }),
    ],
    edges: [
      wire("begin", "execOut", "js", "execIn"),
      wire("js", "execOut", "log", "execIn"),
      wire("js", "out_result", "log", "message"),
    ],
  };
}

const library = (libraryName: string, modules: Record<string, string>, imports: Record<string, Record<string, string>> = {}): ExtensionGameLibrary => ({
  extensionGuid: `${libraryName}-guid`, libraryName, label: libraryName, settings: {}, assets: [],
  bundle: { entry: Object.keys(modules)[0]!, modules: Object.entries(modules).map(([modulePath, code]) => ({ path: modulePath, code, imports: imports[modulePath] ?? {} })) },
});

/** The game's scripts module, written as the exporter writes it, and loaded with a standard module import. */
function writtenModule(text: string): () => Promise<GameScriptsModule> {
  const root = mkdtempSync(path.join(tmpdir(), "game-scripts-"));
  roots.push(root);
  const file = path.join(root, "game-scripts.js");
  writeFileSync(file, text);
  return () => import(/* @vite-ignore */ pathToFileURL(file).href) as Promise<GameScriptsModule>;
}

describe("exported game scripts", () => {
  it("run compiled scripts and Extension libraries from the static module, with no source text left to evaluate", async () => {
    const script = compileClassScript({ registry, classId: "Hero", graph: bodyGraph("result = extensions.tools.describe(value);") });
    const tools = library("tools", {
      "game.js": "const { triple } = require('./code/math');\nexports.describe = (value) => `${triple(value) * 2}`;",
      "code/math.js": "exports.triple = (value) => value * 3;",
    }, { "game.js": { "./code/math": "code/math.js" } });
    const load = writtenModule(writeGameScriptsModule([script], [tools]));
    // As a game ships them: the code is only in the module.
    const shipped = { ...tools, bundle: { ...tools.bundle, modules: tools.bundle.modules.map((module) => ({ ...module, code: "" })) } };
    const scenario = await startGraphScenario({
      scripts: [{ ...script, source: "" }],
      actors: [createActor("hero", "Hero", { classId: "Hero" })],
      runtime: { extensionLibraries: [shipped], moduleLoader: createStaticModuleLoader(load) },
    });
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(scenario.logs("Probe")).toEqual(["18"]);
  });

  it("keeps a script's hoisted loop-guard and location constants working inside the static module", async () => {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        graphNode(registry, "begin", "flow.event.beginPlay"),
        graphNode(registry, "loop", "flow.forLoop", { "default:firstIndex": 1, "default:lastIndex": 3 }),
        graphNode(registry, "log", "debug.log", { category: "Probe" }),
      ],
      edges: [wire("begin", "execOut", "loop", "execIn"), wire("loop", "loopBody", "log", "execIn"), wire("loop", "index", "log", "message")],
    };
    const script = compileClassScript({ registry, classId: "Counter", graph });
    // The compiler hoists module-scope constants (the loop guard's helpers and locations); they become the module
    // function's own, evaluated once when the script loads.
    expect(script.source).toMatch(/^const __loopBound /m);
    const scenario = await startGraphScenario({
      scripts: [{ ...script, source: "" }],
      actors: [createActor("counter", "Counter", { classId: "Counter" })],
      runtime: { moduleLoader: createStaticModuleLoader(writtenModule(writeGameScriptsModule([script], []))) },
    });
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(scenario.logs("Probe")).toEqual(["1", "2", "3"]);
  });

  it("leaves no compiler source label in the module, which would rename the whole file in stack frames", () => {
    const script = compileClassScript({ registry, classId: "Hero", graph: bodyGraph("result = \"//# sourceURL=haptic:///authored.js\";") });
    expect(script.source.startsWith("//# sourceURL=haptic:///")).toBe(true);
    const text = writeGameScriptsModule([script], []);
    expect(text.split("\n").filter((line) => line.startsWith("//# sourceURL="))).toEqual([]);
    // Authored text is never touched.
    expect(text).toContain("//# sourceURL=haptic:///authored.js");
  });

  it("names the failing node of a script in the shared module from the module's own stack frame", async () => {
    const throwing = compileClassScript({ registry, classId: "Thrower", graph: bodyGraph("throw new Error(\"boom from the module\");") });
    const quiet = compileClassScript({ registry, classId: "Quiet", graph: bodyGraph("result = \"ok\";") });
    const text = writeGameScriptsModule([quiet, throwing], []);
    const url = "capacitor://localhost/scripts/game-scripts.js";
    // The module line holding the throw, where a WebKit frame of the shipped module would point.
    const line = text.split("\n").findIndex((entry) => entry.includes("boom from the module")) + 1;
    const column = text.split("\n")[line - 1]!.indexOf("throw") + 1;
    // The functions themselves, made here from the same bodies the module holds, rethrow with that frame.
    const scripts: Record<string, readonly [number, (extensions: unknown) => Record<string, unknown>]> = {};
    for (const script of [quiet, throwing]) {
      const label = compiledScriptSourceLabel(script);
      // The writer names the line after the function's opening line as the source's first.
      const lines = text.split("\n");
      const opening = lines.findIndex((entry) => entry.startsWith(`${JSON.stringify(label)}: [`));
      const firstLine = opening + 2;
      expect(lines[opening]).toBe(`${JSON.stringify(label)}: [${firstLine}, function (extensions) {`);
      const exports = new Function("extensions", compiledModuleBody(script, label)) as (extensions: unknown) => Record<string, (...args: unknown[]) => unknown>;
      scripts[label] = [firstLine, (extensions) => Object.fromEntries(Object.entries(exports(extensions)).map(([name, run]) => [name, (...args: unknown[]) => {
        try { return run(...args); } catch (error) {
          throw Object.assign(new Error((error as Error).message), { stack: `Error: ${(error as Error).message}\n${name}@${url}:${line}:${column}` });
        }
      }]))];
    }
    const scenario = await startGraphScenario({
      scripts: [{ ...quiet, source: "" }, { ...throwing, source: "" }],
      actors: [createActor("quiet", "Quiet", { classId: "Quiet" }), createActor("thrower", "Thrower", { classId: "Thrower" })],
      runtime: { moduleLoader: createStaticModuleLoader(async () => ({ url, scripts, extensions: {}, particleKernels: {} })) },
    });
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([expect.objectContaining({
      message: "boom from the module", assetGuid: throwing.assetGuid, nodeId: "js",
    })]);
  });
});
