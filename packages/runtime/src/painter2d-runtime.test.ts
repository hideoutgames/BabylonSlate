import { describe, expect, it } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createActor, createDefaultScene, createDefaultSceneLayer, PAINTER_MAX_MASK_DEPTH, type Painter2DProperties } from "@babylonslate/core";
import { isPlayEngineCommandType, type CommandMessage } from "@babylonslate/bridge";
import { Painter2DRuntime } from "./painter2d-runtime";
import { createInProcessRuntime } from "./driver";

function painter(id: string, clearEachFrame = false) {
  const actor = new Actor({ guid: id, classId: "SceneLayerActor", sceneLayerId: "layer" });
  const component = new ActorComponent({ guid: `${id}-painter`, classId: "2DPainterComponent", variables: { clearEachFrame } });
  actor.attachComponent(component);
  return { actor, component };
}

describe("2D Painter retained drawing", () => {
  it("captures independent style and path snapshots, retains sibling drawing, and balances masks", () => {
    const runtime = new Painter2DRuntime();
    const a = painter("a"), b = painter("b");
    runtime.execute(a.component, "painterMoveTo", { point: [-2, 0] });
    runtime.execute(a.component, "painterBezierTo", { control1: [-1, 2], control2: [1, 2], point: [2, 0] });
    runtime.execute(a.component, "painterClosePath", {});
    a.component.setVariable("fillColor", [1, 0, 0, 0.5]);
    expect(runtime.execute(a.component, "painterFillPath", {})).toBe(true);
    runtime.execute(a.component, "painterPushMask", {});
    runtime.execute(a.component, "painterBeginPath", {});
    runtime.execute(a.component, "painterMoveTo", { point: [0, 0] });
    runtime.execute(a.component, "painterQuadraticTo", { control: [1, 1], point: [2, 0] });
    runtime.execute(a.component, "painterCutOutPath", {});
    expect(runtime.execute(a.component, "painterPopMask", {})).toBe(true);
    expect(runtime.execute(a.component, "painterPopMask", {})).toBe(false);
    runtime.execute(b.component, "painterDrawPolyline", { points: [[0, 0], [1, 2]] });
    a.component.setVariable("fillColor", [0, 1, 0, 1]);
    const commands = runtime.payload(a.component).commands;
    expect(commands).toMatchObject([
      { kind: "draw", fill: true, stroke: false, path: [{ kind: "move", point: [-2, 0] }, { kind: "bezier", control1: [-1, 2], control2: [1, 2], point: [2, 0] }, { kind: "close" }], style: { fillColor: [1, 0, 0, 0.5] } },
      { kind: "pushMask" }, { kind: "cutout", path: [{ kind: "move", point: [0, 0] }, { kind: "quadratic", control: [1, 1], point: [2, 0] }] }, { kind: "popMask" },
    ]);
    runtime.execute(a.component, "painterClear", {});
    expect(runtime.payload(a.component).commands).toEqual([]);
    expect(runtime.payload(b.component).commands).toMatchObject([{ kind: "draw", fill: false, path: [{ kind: "move", point: [0, 0] }, { kind: "line", point: [1, 2] }] }]);
    expect(commands).toHaveLength(4);
  });

  it("clears only ticking frame painters and rejects invalid paths without changing drawing", () => {
    const runtime = new Painter2DRuntime();
    const a = painter("frame", true), b = painter("retained"), sleeping = painter("sleeping", true);
    for (const item of [a, b, sleeping]) runtime.execute(item.component, "painterDrawRectangle", { center: [2, 1], size: [4, 2] });
    expect(runtime.execute(b.component, "painterDrawPolyline", { points: [[0, 0], [NaN, 1]] })).toBe(false);
    expect(runtime.execute(b.component, "painterDrawCircle", { center: [0, 0], radius: -2 })).toBe(false);
    runtime.beginFrame([a.actor, b.actor, sleeping.actor], (actor) => actor !== sleeping.actor);
    expect(runtime.payload(a.component).commands).toEqual([]);
    expect(runtime.payload(b.component).commands).toMatchObject([{ path: [{ point: [0, 0] }, { point: [4, 0] }, { point: [4, 2] }, { point: [0, 2] }, { kind: "close" }] }]);
    expect(runtime.payload(sleeping.component).commands).toHaveLength(1);
    runtime.execute(b.component, "painterMoveTo", { point: [0, 0] });
    runtime.execute(b.component, "painterLineTo", { point: [1, 1] });
    for (let index = 0; index < PAINTER_MAX_MASK_DEPTH; index++) expect(runtime.execute(b.component, "painterPushMask", {})).toBe(true);
    expect(runtime.execute(b.component, "painterPushMask", {})).toBe(false);
    runtime.execute(b.component, "painterClear", {});
    expect(runtime.execute(b.component, "painterPopMask", {})).toBe(false);
    const sent: Painter2DProperties[] = [];
    runtime.flush((_component, payload) => sent.push(payload));
    expect(sent).toHaveLength(3);
    runtime.flush((_component, payload) => sent.push(payload));
    expect(sent).toHaveLength(3);
  });

  it("rejects invalid scalar geometry without adding drawing or path segments, then accepts valid operations", () => {
    const runtime = new Painter2DRuntime(), { component } = painter("validated");
    runtime.execute(component, "painterDrawLine", { start: [-1, 0], end: [1, 0] });
    runtime.execute(component, "painterMoveTo", { point: [0, 0] });
    const retained = runtime.payload(component).commands;
    runtime.flush(() => {});
    for (const radius of [NaN, Infinity, "2", null, undefined]) {
      expect(runtime.execute(component, "painterDrawCircle", { center: [0, 0], radius })).toBe(false);
    }
    const arc = { center: [1, 2], radius: [2, 1] };
    for (const invalid of [{ rotation: NaN }, { startAngle: Infinity }, { endAngle: "3" }, { endAngle: null }, { anticlockwise: 1 }]) {
      expect(runtime.execute(component, "painterArc", { ...arc, ...invalid })).toBe(false);
    }
    expect(runtime.execute(component, "painterDrawRectangle", { center: [Number.MAX_VALUE, 0], size: [Number.MAX_VALUE, 1] })).toBe(false);
    const rejectedUpdates: Painter2DProperties[] = [];
    runtime.flush((_component, payload) => rejectedUpdates.push(payload));
    expect(rejectedUpdates).toEqual([]);
    expect(runtime.payload(component).commands).toEqual(retained);

    expect(runtime.execute(component, "painterDrawCircle", { center: [2, 3], radius: 0.5 })).toBe(true);
    expect(runtime.execute(component, "painterArc", arc)).toBe(true);
    expect(runtime.execute(component, "painterLineTo", { point: [3, 2] })).toBe(true);
    expect(runtime.execute(component, "painterStrokePath", {})).toBe(true);
    const commands = runtime.payload(component).commands;
    expect(commands).toHaveLength(3);
    expect(commands[0]).toEqual(retained[0]);
    expect(commands[1]).toMatchObject({ path: [{ kind: "ellipse", center: [2, 3], radius: [0.5, 0.5] }, { kind: "close" }] });
    expect(commands[2]).toMatchObject({ fill: false, stroke: true, path: [
      { kind: "move", point: [0, 0] },
      { kind: "ellipse", center: [1, 2], radius: [2, 1], rotation: 0, start: 0, end: Math.PI * 2, anticlockwise: false },
      { kind: "line", point: [3, 2] },
    ] });
  });

  it("sends native graph drawing to both Play hosts and clears before Tick without rebuilding meshes", async () => {
    const commands: CommandMessage[] = [];
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("canvas", "Canvas", { classId: "CanvasActor", components: [{ id: "ink", classId: "2DPainterComponent", properties: {} }] })];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, seedDemoActors: false, playScene: createDefaultScene(), sceneLayerLibrary: { canvas: layer }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "canvas-script", classId: "CanvasActor", parentClassId: "SceneLayerActor", anchors: [],
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
        source: 'export function onTick(ctx) { const ink = ctx.getComponentById(ctx.self, "ink"); ctx.callComponentFunction(ink, "painterDrawCircle", {center: {x:1,y:2}, radius: 0.5}); ctx.callComponentFunction(ink, "painterDrawLine", {start: {x:0,y:0}, end: {x:1,y:1}}); }',
      }]);
      runtime.realizePlayWorld(); const canvas = runtime.createSceneLayer("canvas")!; runtime.start();
      const assignmentCount = commands.filter((command) => command.type === "assignMesh").length;
      runtime.tick(); runtime.tick();
      const updates = commands.filter((command) => command.type === "setPainter2D");
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(isPlayEngineCommandType("setPainter2D")).toBe(true);
      expect(updates.at(-1)).toMatchObject({ componentId: "ink", painter: { commands: [
        { kind: "draw", path: [{ kind: "ellipse", center: [1, 2], radius: [0.5, 0.5] }, { kind: "close" }] },
        { kind: "draw", fill: false, path: [{ kind: "move", point: [0, 0] }, { kind: "line", point: [1, 1] }] },
      ] } });
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(assignmentCount);
      expect(commands.find((command) => command.type === "assignMesh" && command.actorGuid === `${canvas.guid}:canvas`)).toMatchObject({ meshKind: "2dpainter", parts: [{ componentId: "ink", painter: { width: 10, height: 10 } }] });
    } finally { runtime.stop(); }
  });
});
