import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createMeshComponent } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import { runtimeOptionsFromLoadControl } from "./play-load";

describe("render target graph runtime", () => {
  it("spawns the built-in capture actor with a lens without requiring an authored class", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command),
    });
    try {
      const actor = runtime.spawnScriptedActor({ classId: "RenderTargetCapture" });
      expect(actor?.components.filter((component) => component.classId === "RenderTargetCaptureComponent")).toHaveLength(1);
      expect(commands.find((command) => command.type === "configureRenderTargetCapture"))
        .toMatchObject({ actorGuid: actor!.guid, settings: { enabled: true, captureOnlyActors: false } });
      expect(commands.find((command) => command.type === "assignMesh"))
        .toMatchObject({ meshKind: "renderTargetCapture" });
    } finally { runtime.stop(); }
  });

  it("reads asset mode and texture references after worker loading and edits actor filters without rebuilding meshes", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      ...runtimeOptionsFromLoadControl({
        type: "load", sceneAssetGuid: "scene",
        scene: { ...createDefaultScene(), actors: [
          createActor("capture", "Capture", { classId: "Monitor", components: [
            { id: "lens", classId: "RenderTargetCaptureComponent", properties: { renderTargetGuid: "depth", captureEveryFrame: false } },
          ] }),
          createActor("subject", "Subject", { components: [createMeshComponent("subject-mesh")] }),
        ] },
        renderTargets: { depth: { mode: "DepthPass", width: 128, height: 64 } },
        renderTargetTextures: { image: { renderTargetGuid: "depth" } },
      }),
      cooperativeSceneLoading: false, preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "monitor", classId: "Monitor", parentClassId: "RenderTargetCapture",
        anchors: [], entryPoints: [{ name: "Update", event: "Update", isAsync: false }],
        source: `export function Update(ctx) {
          const actors = ctx.getAllActorsOfClass("Actor");
          const subject = actors.find(actor => actor.guid === "subject");
          ctx.setVariable("mode", ctx.getRenderTargetMode(ctx.getRenderTargetTextureTarget("image")));
          ctx.setRenderTargetCaptureProperty(ctx.self, "actorIds", [subject, subject]);
          ctx.setRenderTargetCaptureProperty(ctx.self, "captureOnlyActors", true);
          ctx.setVariable("selected", ctx.getRenderTargetCaptureProperty(ctx.self, "actorIds"));
          const lens = ctx.getComponentById(ctx.self, "lens");
          ctx.setVariable("reflected", ctx.getVariableFrom(lens, "actorIds"));
          ctx.captureRenderTarget(ctx.self);
        }`,
      }]);
      runtime.realizePlayWorld();
      const actor = runtime.getWorld().findActor("capture")!;
      const subject = runtime.getWorld().findActor("subject")!;
      expect(commands.filter((command) => command.type === "configureRenderTargetCapture").at(-1))
        .toMatchObject({ settings: { captureOnlyActors: false, actorIds: [], captureEveryFrame: false } });
      const meshCount = commands.filter((command) => command.type === "assignMesh").length;
      runtime.invokeScriptEvent("Monitor", "Update", actor);
      expect(actor.getVariable("mode")).toBe("DepthPass");
      expect(actor.getVariable("selected")).toEqual([subject]);
      expect(actor.getVariable("reflected")).toEqual([subject]);
      expect(commands.filter((command) => command.type === "configureRenderTargetCapture").at(-1))
        .toMatchObject({ actorGuid: "capture", settings: { captureOnlyActors: true, actorIds: ["subject"] } });
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(meshCount);
      expect(commands.filter((command) => command.type === "captureRenderTarget"))
        .toEqual([{ type: "captureRenderTarget", actorGuid: "capture" }]);
      expect(commands.filter((command) => command.type === "assignMesh").some((command) => command.camera !== undefined)).toBe(false);
    } finally { runtime.stop(); }
  });

  it("rejects non-actor filter values, returns detached lists, and preserves empty enabled filters", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { ...createDefaultScene(), actors: [createActor("capture", "Capture", { classId: "Monitor", components: [
        { id: "lens", classId: "RenderTargetCaptureComponent", properties: { captureOnlyActors: true, actorIds: ["missing"] } },
      ] })] }, onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "monitor", classId: "Monitor", parentClassId: "RenderTargetCapture",
        anchors: [], entryPoints: [{ name: "Update", event: "Update", isAsync: false }],
        source: `export function Update(ctx) {
          const lens = ctx.getComponentById(ctx.self, "lens");
          ctx.setVariableOn(lens, "actorIds", [ctx.self]);
          const selected = ctx.getVariableFrom(lens, "actorIds"); selected.length = 0;
          ctx.setRenderTargetCaptureProperty(ctx.self, "actorIds", ["capture"]);
          ctx.setVariable("selected", ctx.getRenderTargetCaptureProperty(ctx.self, "actorIds"));
          ctx.setRenderTargetCaptureProperty(ctx.self, "actorIds", []);
          ctx.captureRenderTarget(null);
          ctx.setVariable("missingMode", ctx.getRenderTargetMode("missing"));
          ctx.setVariable("missingTexture", ctx.getRenderTargetTextureTarget("missing"));
        }`,
      }]);
      runtime.realizePlayWorld();
      const actor = runtime.getWorld().findActor("capture")!;
      runtime.invokeScriptEvent("Monitor", "Update", actor);
      expect(actor.getVariable("selected")).toEqual([actor]);
      expect(actor.getVariable("missingMode")).toBe("SceneColor");
      expect(actor.getVariable("missingTexture")).toBeNull();
      expect(commands.filter((command) => command.type === "configureRenderTargetCapture").at(-1))
        .toMatchObject({ settings: { captureOnlyActors: true, actorIds: [] } });
      expect(commands.some((command) => command.type === "captureRenderTarget")).toBe(false);
    } finally { runtime.stop(); }
  });
});
