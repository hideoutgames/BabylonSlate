import { describe, expect, it } from "vitest";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function script(label: string): CompiledScript {
  return { assetGuid: "class-a", classId: "SourceActor", parentClassId: "Actor", anchors: [],
    source: `export function tick(ctx) { ctx.log("log", "source-test", ${JSON.stringify(label)}); }`,
    entryPoints: [{ name: "tick", event: "onTick", isAsync: false }] };
}

describe("owned compiled script sources", () => {
  it("maps a genuine compiled error to the correct adjacent authored node", async () => {
    const failures: Array<{ nodeId?: string; bodyLine?: number }> = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false,
      onCommand: (command) => { if (command.type === "diagnostic" && command.message === "actual-body") failures.push(command); } });
    const source: CompiledScript = { ...script("throwing"), source: [
      "//# sourceURL=babylonslate:///class-a.js",
      "export function tick(ctx) {",
      "  const marker = 1;",
      '  throw new Error("actual-body");',
      '  ctx.log("log", "source-test", marker);',
      "}",
    ].join("\n"), anchors: [
      { assetGuid: "class-a", graphId: "authored-js", nodeId: "previous", line: 3, column: 1, bodyLine: 1 },
      { assetGuid: "class-a", graphId: "authored-js", nodeId: "throwing", line: 4, column: 1, bodyLine: 2 },
      { assetGuid: "class-a", graphId: "authored-js", nodeId: "next", line: 5, column: 1, bodyLine: 3 },
    ] };
    try {
      await runtime.replaceScriptSources([source]);
      runtime.spawnScriptedActor({ classId: source.classId });
      runtime.start();
      runtime.tick();
      expect(failures).toEqual([expect.objectContaining({ nodeId: "throwing", bodyLine: 2 })]);
    } finally { runtime.stop(); }
  });

  it("owns every Class module from one AnimationGraph asset and removes only retired modules", async () => {
    const messages: string[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log" && command.category === "source-test") messages.push(command.message); } });
    const first: CompiledScript = { ...script("event"), assetGuid: "animation-owner", classId: "AnimEvent",
      anchors: [{ assetGuid: "animation-owner", graphId: "event-graph", nodeId: "event-node", line: 3, column: 1 }] };
    const second: CompiledScript = { ...script("rule"), assetGuid: "animation-owner", classId: "AnimRule",
      anchors: [{ assetGuid: "animation-owner", graphId: "rule-graph", nodeId: "rule-node", line: 3, column: 1 }] };
    const diagnostic = (classId: string) => {
      const error = new Error("module failure");
      error.stack = `Error: module failure\n    at tick (babylonslate:///animation-owner~${classId}.js:6:1)`;
      return runtime.reportError(error);
    };
    try {
      await runtime.loadScripts([first, second]);
      await runtime.replaceScriptSources([second, first]);
      const event = runtime.spawnScriptedActor({ classId: first.classId })!;
      const rule = runtime.spawnScriptedActor({ classId: second.classId })!;
      runtime.start();
      runtime.tick();
      expect(messages).toEqual(["event", "rule"]);
      expect(diagnostic("AnimEvent")?.nodeId).toBe("event-node");
      expect(diagnostic("AnimRule")?.nodeId).toBe("rule-node");
      runtime.getWorld().destroyActor(event.guid);
      runtime.tick();
      await runtime.replaceScriptSources([second]);
      expect(runtime.getWorld().classRegistry.has(first.classId)).toBe(false);
      expect(runtime.getWorld().classRegistry.has(second.classId)).toBe(true);
      expect(diagnostic("AnimEvent")?.nodeId).toBeUndefined();
      expect(diagnostic("AnimRule")?.nodeId).toBe("rule-node");
      runtime.getWorld().destroyActor(rule.guid);
      runtime.tick();
      await runtime.replaceScriptSources([]);
      expect(runtime.getWorld().classRegistry.has(second.classId)).toBe(false);
      expect(diagnostic("AnimRule")?.nodeId).toBeUndefined();
    } finally { runtime.stop(); }
  });

  it("deduplicates the owned union and retains a live class until its final actor retires", async () => {
    const messages: string[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log" && command.category === "source-test") messages.push(command.message); } });
    try {
      const source = script("ready");
      await runtime.replaceScriptSources([source]);
      await runtime.replaceScriptSources([source]);
      const actor = runtime.spawnScriptedActor({ classId: source.classId })!;
      runtime.start();
      runtime.tick();
      expect(messages).toEqual(["ready"]);
      await runtime.replaceScriptSources([]);
      runtime.tick();
      expect(messages).toEqual(["ready", "ready"]);
      runtime.getWorld().destroyActor(actor.guid);
      runtime.tick();
      await runtime.replaceScriptSources([]);
      expect(runtime.spawnScriptedActor({ classId: source.classId })).toBeNull();
      expect(runtime.getWorld().classRegistry.has(source.classId)).toBe(false);
      expect(runtime.getWorld().classRegistry.has("Actor")).toBe(true);
    } finally { runtime.stop(); }
  });

  it("keeps the prior functions on a corrupt replacement and allows a corrected retry", async () => {
    const messages: string[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log" && command.category === "source-test") messages.push(command.message); } });
    try {
      await runtime.replaceScriptSources([script("old")]);
      runtime.spawnScriptedActor({ classId: "SourceActor" });
      runtime.start();
      await expect(runtime.replaceScriptSources([{ ...script("broken"), source: "export function invalid( {" }])).rejects.toThrow();
      runtime.tick();
      expect(messages).toEqual(["old"]);
      await runtime.replaceScriptSources([script("new")]);
      runtime.tick();
      expect(messages).toEqual(["old", "new"]);
    } finally { runtime.stop(); }
  });

  it("cannot publish queued class registration after a project stops", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false });
    const pending = runtime.replaceScriptSources([script("late")]);
    runtime.stop();
    await expect(pending).rejects.toThrow("stopped");
    expect(runtime.getWorld().classRegistry.has("SourceActor")).toBe(false);
  });
});
