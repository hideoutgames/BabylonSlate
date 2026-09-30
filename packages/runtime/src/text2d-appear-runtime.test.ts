import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import { isPlayEngineCommandType, type CommandMessage } from "@babylonslate/bridge";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";
import { Text2DAppearRuntime } from "./text2d-appear-runtime";

function text(variables: Record<string, unknown> = {}) {
  const actor = new Actor({ classId: "SceneLayerActor", sceneLayerId: "layer" });
  const component = new ActorComponent({ classId: "2DRichTextComponent", variables: {
    text: "[b]A[/b][img=icon][wave speed=2]B[/wave]", appearModes: ["fade"],
    appearStart: "hidden", appearInterval: 0.1, appearDuration: 0.3, ...variables,
  } });
  actor.attachComponent(component);
  return { actor, component };
}

describe("2D rich text appearance runtime", () => {
  it("reverses from the current position and preserves it through text, timing, and style edits", () => {
    const runtime = new Text2DAppearRuntime(), { actor, component } = text();
    expect(runtime.progress(component)).toBe(0);
    runtime.execute(component, "play");
    runtime.advance([actor], 0.2, () => true);
    // Three formatted characters: two 0.1-second intervals and a 0.3-second transition.
    expect(runtime.progress(component)).toBeCloseTo(0.4);
    component.setVariable("text", "ABCDE");
    component.setVariable("appearInterval", 0);
    component.setVariable("appearDuration", 0.5);
    component.setVariable("color", [0, 1, 0]);
    runtime.refresh(component);
    expect(runtime.progress(component)).toBeCloseTo(0.4);
    runtime.execute(component, "playReverse");
    runtime.advance([actor], 0.1, () => true);
    expect(runtime.progress(component)).toBeCloseTo(0.2);
    runtime.advance([actor], 1, () => true);
    expect(runtime.progress(component)).toBe(0);
    runtime.execute(component, "play");
    runtime.advance([actor], 1, () => true);
    expect(runtime.progress(component)).toBe(1);
    runtime.execute(component, "triggerAppear");
    expect(runtime.progress(component)).toBe(0);
    runtime.advance([actor], 0.25, () => true);
    expect(runtime.progress(component)).toBe(0.5);
  });

  it("advances auto-play only for ready owners and sends no update for destroyed components", () => {
    const runtime = new Text2DAppearRuntime(), ready = text({ appearStart: "play" }), waiting = text({ appearStart: "play" });
    runtime.advance([ready.actor, waiting.actor], 0.25, (actor) => actor === ready.actor);
    expect(runtime.progress(ready.component)).toBe(0.5);
    expect(runtime.progress(waiting.component)).toBe(0);
    ready.component.destroyed = true;
    const updates: number[] = [];
    runtime.flush((_component, progress) => updates.push(progress));
    expect(updates).toEqual([]);
    runtime.advance([ready.actor, waiting.actor], 0.5, () => true);
    expect(runtime.progress(waiting.component)).toBe(1);
  });

  it("finishes disabled animations synchronously and does not leave zero-character text playing", () => {
    for (const variables of [{ appearModes: [] }, { text: "[b][/b]" }]) {
      const runtime = new Text2DAppearRuntime(), { component } = text(variables);
      runtime.execute(component, "play");
      expect(runtime.progress(component)).toBe(1);
      runtime.execute(component, "playReverse");
      expect(runtime.progress(component)).toBe(0);
      runtime.execute(component, "triggerAppear");
      expect(runtime.progress(component)).toBe(1);
    }
  });

  it("publishes live graph getters and component updates without rebuilding meshes on each tick", async () => {
    const commands: CommandMessage[] = [];
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("label", "Label", { classId: "LabelActor", components: [
      { id: "rich", classId: "2DRichTextComponent", properties: {
        text: "[b]A[/b][img=icon]B", appearModes: ["fade", "scale"], appearStart: "hidden", appearDuration: 0.3, appearInterval: 0.1,
      } },
      { id: "other", classId: "2DRichTextComponent", properties: { text: "Other" } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true, seedDemoActors: false,
      playScene: createDefaultScene(), sceneLayerLibrary: { labels: layer }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "label-script", classId: "LabelActor", parentClassId: "SceneLayerActor", anchors: [],
        entryPoints: ["Play", "Reverse", "Restart", "Edit", "onTick"].map((name) => ({ name, event: name, isAsync: false })),
        source: `
          export function Play(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "play", {}); }
          export function Reverse(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "playReverse", {}); }
          export function Restart(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "rich"), "triggerAppear", {}); }
          export function Edit(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "rich"), "color", [1, 0, 0]); }
          export function onTick(ctx) {
            const c = ctx.getComponentById(ctx.self, "rich");
            ctx.setVariable("progress", ctx.getVariableFrom(c, "appearProgress"));
            ctx.setVariable("revealed", ctx.getVariableFrom(c, "isRevealed"));
          }`,
      }]);
      runtime.realizePlayWorld(); runtime.createSceneLayer("labels"); runtime.start();
      const actor = runtime.getWorld().findActor("label")!;
      const assignments = () => commands.filter((command) => command.type === "assignMesh");
      const initialAssignments = assignments().length;
      runtime.invokeScriptEvent("LabelActor", "Play", actor);
      runtime.tick();
      expect(actor.getVariable("progress")).toBeCloseTo(0.2);
      expect(actor.getVariable("revealed")).toBe(false);
      expect(assignments()).toHaveLength(initialAssignments);
      const updates = commands.filter((command) => command.type === "setText2DAppear");
      expect(updates.at(-1)).toMatchObject({ componentId: "rich", progress: 0.2 });
      expect(updates.every((command) => command.componentId === "rich")).toBe(true);
      expect(isPlayEngineCommandType("setText2DAppear")).toBe(true);
      runtime.pause(); runtime.tick();
      expect(actor.getVariable("progress")).toBeCloseTo(0.2);
      runtime.resume();
      runtime.invokeScriptEvent("LabelActor", "Edit", actor);
      expect(assignments().at(-1)).toMatchObject({ parts: [
        { componentId: "rich", text2d: { appearProgress: 0.2, color: [1, 0, 0] } },
        { componentId: "other", text2d: { appearProgress: 1 } },
      ] });
      for (let i = 0; i < 4; i++) runtime.tick();
      expect(actor.getVariable("progress")).toBe(1);
      expect(actor.getVariable("revealed")).toBe(true);
      runtime.invokeScriptEvent("LabelActor", "Reverse", actor); runtime.tick();
      expect(actor.getVariable("progress")).toBeCloseTo(0.8);
      expect(actor.getVariable("revealed")).toBe(false);
      runtime.invokeScriptEvent("LabelActor", "Restart", actor);
      expect(commands.filter((command) => command.type === "setText2DAppear").at(-1)).toMatchObject({ progress: 0 });
    } finally { runtime.stop(); }
  });
});
