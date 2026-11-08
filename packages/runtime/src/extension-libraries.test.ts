import { describe, expect, it } from "vitest";
import { createActor, type ExtensionGameLibrary } from "@haptic/core";
import type { LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { runtimeOptionsFromLoadControl } from "./play-load";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

function library(libraryName: string, modules: Record<string, string>, entry = Object.keys(modules)[0]!, imports: Record<string, Record<string, string>> = {}, settings: ExtensionGameLibrary["settings"] = {}, assets: ExtensionGameLibrary["assets"] = []): ExtensionGameLibrary {
  return {
    extensionGuid: `${libraryName}-guid`,
    libraryName,
    label: libraryName[0]!.toUpperCase() + libraryName.slice(1),
    settings,
    assets,
    bundle: { entry, modules: Object.entries(modules).map(([path, code]) => ({ path, code, imports: imports[path] ?? {} })) },
  };
}

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

async function run(body: string, extensionLibraries: ExtensionGameLibrary[]) {
  const scenario = await startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Hero", graph: bodyGraph(body) })],
    actors: [createActor("hero", "Hero", { classId: "Hero" })],
    runtime: { extensionLibraries },
  });
  scenario.stop();
  return scenario;
}

describe("Extension game libraries", () => {
  it("are reachable from Execute JavaScript, and each sees the libraries loaded before it", async () => {
    const base = library("base", { "game.js": "exports.double = (value) => value * 2;" });
    const tools = library("tools", {
      "game.js": "const { triple } = require('./code/math');\nexports.describe = (value) => `${extensions.base.double(triple(value))}`;",
      "code/math.js": "exports.triple = (value) => value * 3;",
    }, "game.js", { "game.js": { "./code/math": "code/math.js" } });

    const scenario = await run("result = extensions.tools.describe(value);", [base, tools]);

    expect(scenario.diagnostics()).toEqual([]);
    expect(scenario.logs("Probe")).toEqual(["18"]);
  });

  it("give each library its own Project Settings values through haptic:extension", async () => {
    const weather = library("weather", {
      "game.js": "const { settings } = require('haptic:extension');\nexports.describe = (value) => `${settings.region}:${settings.scale * value}`;",
    }, "game.js", { "game.js": { "haptic:extension": "haptic:extension" } }, { region: "north", scale: 2 });

    const scenario = await run("result = extensions.weather.describe(value);", [weather]);

    expect(scenario.diagnostics()).toEqual([]);
    expect(scenario.logs("Probe")).toEqual(["north:6"]);
  });

  it("give each library its own gameplay assets through haptic:extension, frozen", async () => {
    const weather = library("weather", {
      "game.js": [
        "const { assets } = require('haptic:extension');",
        "exports.describe = (value) => {",
        "  const presets = assets.list('preset');",
        "  let mutated = 'no';",
        "  try { presets[0].values.rain = 99; mutated = String(presets[0].values.rain === 99); } catch { mutated = 'threw'; }",
        "  return [presets.map((asset) => `${asset.name}=${asset.values.rain * value}`).join(','), assets.list().length,",
        "    assets.get('zone-guid')?.name, String(assets.get('missing')), mutated].join('|');",
        "};",
      ].join('\n'),
    }, "game.js", { "game.js": { "haptic:extension": "haptic:extension" } }, {}, [
      { guid: "dry-guid", name: "Dry", type: "preset", values: { rain: 0 } },
      { guid: "wet-guid", name: "Wet", type: "preset", values: { rain: 2 } },
      { guid: "zone-guid", name: "Coast", type: "zone", values: { radius: 5 } },
    ]);

    const scenario = await run("result = extensions.weather.describe(value);", [weather]);

    expect(scenario.diagnostics()).toEqual([]);
    // Library code runs in strict mode only when it opts in, so a frozen write is ignored rather than thrown.
    expect(scenario.logs("Probe")).toEqual(["Dry=0,Wet=6|3|Coast|null|false"]);
  });

  it("reports a library that fails to load and still loads the others", async () => {
    const broken = library("broken", { "game.js": "throw new Error('boom');" });
    const base = library("base", { "game.js": "exports.ready = true;" });

    const scenario = await run("result = Object.keys(extensions).join(',');", [broken, base]);

    expect(scenario.diagnostics()).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("Extension Broken failed to load: boom") }),
    ]);
    expect(scenario.logs("Probe")).toEqual(["base"]);
  });

  it("reach the runtime from the worker load message", () => {
    const base = library("base", { "game.js": "exports.ready = true;" });
    expect(runtimeOptionsFromLoadControl({ type: "load", seed: 1, sceneAssetGuid: "scene", extensionLibraries: [base] }).extensionLibraries).toEqual([base]);
  });
});
