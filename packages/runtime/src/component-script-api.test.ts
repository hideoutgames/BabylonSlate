import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  createText3DComponent,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

describe("component script API", () => {
  it("Set Text updates the component text, refreshes the mesh, and fires On Text Changed", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      playScene: {
        name: "Label",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("label", "Label", {
            classId: "Hero",
            components: [createText3DComponent("text-1")],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    const script: CompiledScript = {
      assetGuid: "hero-script",
      classId: "Hero",
      parentClassId: "Actor",
      source: [
        "export function onBeginPlay(ctx) {",
        '  const c = ctx.getComponentById(ctx.self, "text-1");',
        '  ctx.callComponentFunction(c, "setText", { text: "Hi" });',
        "}",
        "export function onTextChanged(ctx) {",
        '  ctx.log("log", "Changed", String(ctx.args.text ?? ""));',
        "}",
      ].join("\n"),
      anchors: [],
      entryPoints: [
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        {
          name: "onTextChanged",
          event: "onTextChanged",
          isAsync: false,
          componentId: "text-1",
        },
      ],
    };
    await runtime.loadScripts([script]);
    runtime.realizePlayWorld();
    const actor = runtime.getWorld().findActor("label");
    const text = actor?.components.find((c) => c.guid === "text-1");
    expect(text?.getVariable("text")).toBe("Hi");
    expect(
      commands.some(
        (command) =>
          command.type === "log" &&
          command.category === "Changed" &&
          command.message === "Hi",
      ),
    ).toBe(true);
    const assigns = commands.filter(
      (command) =>
        command.type === "assignMesh" &&
        "text3d" in command &&
        command.text3d?.text === "Hi",
    );
    expect(assigns.length).toBeGreaterThan(0);
    runtime.stop();
  });
});
