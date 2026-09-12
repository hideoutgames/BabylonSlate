import { describe, expect, it } from "vitest";
import { type InputAssetDefinition } from "@babylonslate/core";
import { encodeInputEvents } from "@babylonslate/input";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";

const assets: InputAssetDefinition[] = [
  {
    guid: "jump",
    name: "Jump",
    type: "InputAction",
    valueType: "button",
    bindings: [{ id: "jump-key", device: "key", code: "Space" }],
  },
  {
    guid: "confirm",
    name: "Confirm",
    type: "InputAction",
    valueType: "button",
    bindings: [{ id: "confirm-key", device: "key", code: "Enter" }],
  },
  {
    guid: "move",
    name: "Move",
    type: "InputAxis",
    valueType: "2d",
    bindings: [
      {
        id: "forward",
        device: "key",
        code: "KeyW",
        component: "y",
        digitalValue: 1,
      },
    ],
  },
];
const jump = { Name: "Jump", Asset: "jump" };
const confirm = { Name: "Confirm", Asset: "confirm" };
const move = { Name: "Move", Asset: "move" };
const registry = createDefaultNodeRegistry();
const node = (
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode => ({
  id,
  typeId,
  properties,
  position: { x: 0, y: 0 },
  pins: registry.get(typeId)!.pins(properties),
});
const edge = (
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) => ({
  id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}-${targetPinId}`,
  sourceNodeId,
  sourcePinId,
  targetNodeId,
  targetPinId,
});
async function load(
  runtime: ReturnType<typeof createInProcessRuntime>,
  nodes: GraphNode[],
  edges: LogicGraph["edges"],
) {
  const compiled = compileGraph(
    { id: "input", kind: "event", nodes, edges },
    { assetGuid: "rebinder", registry },
  );
  await runtime.loadScripts([
    { assetGuid: "rebinder", classId: "Rebinder", ...compiled },
  ]);
  runtime.spawnScriptedActor({ classId: "Rebinder" });
}

describe("compiled runtime input rebinding", () => {
  it.each([
    ["input.resetInput", { input: jump }, "Space", "KeyC"],
    ["input.resetAllBindings", {}, "Space", "Enter"],
  ])(
    "executes %s against the selected player bindings",
    async (typeId, properties, jumpKey, confirmKey) => {
      const runtime = createInProcessRuntime({
        seed: 1,
        seedDemoActors: false,
        inputAssets: assets,
      });
      runtime.inputBindings.setInputActionBinding!(
        runtime.inputBindings.getInputBindings!(jump)[0]!,
        "KeyJ",
      );
      runtime.inputBindings.setInputActionBinding!(
        runtime.inputBindings.getInputBindings!(confirm)[0]!,
        "KeyC",
      );
      await load(
        runtime,
        [
          node("begin", "flow.event.beginPlay"),
          node("reset", typeId, properties),
        ],
        [edge("begin", "execOut", "reset", "execIn")],
      );
      runtime.start();
      expect(runtime.inputBindings.getInputBindings!(jump)[0].Key).toBe(
        jumpKey,
      );
      expect(runtime.inputBindings.getInputBindings!(confirm)[0].Key).toBe(
        confirmKey,
      );
      runtime.stop();
    },
  );

  it("uses every Any Key edge to rebind and executes once per press across worker input transport", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      inputAssets: assets,
    });
    const binding = runtime.inputBindings.getInputBindings!(jump)[0]!;
    await load(
      runtime,
      [
        node("any", "input.onAnyKeyPressed"),
        node("set", "input.setActionBinding", { binding }),
        node("log", "debug.log"),
      ],
      [
        edge("any", "execOut", "set", "execIn"),
        edge("any", "key", "set", "key"),
        edge("set", "execOut", "log", "execIn"),
        edge("any", "key", "log", "message"),
      ],
    );
    runtime.start();
    runtime.pushInputBuffer(
      encodeInputEvents([
        { kind: "key", tick: 0, phase: "down", code: "KeyJ" },
        { kind: "key", tick: 0, phase: "down", code: "KeyJ" },
        { kind: "key", tick: 0, phase: "up", code: "KeyJ" },
        {
          kind: "pointer",
          tick: 0,
          pointerId: 1,
          phase: "down",
          x: 10,
          y: 20,
          button: 0,
        },
      ]),
    );
    runtime.tick();
    expect(
      runtime
        .getLogRing()
        .entries()
        .map((entry) => entry.message),
    ).toEqual(["KeyJ", "MouseLeft"]);
    expect(runtime.inputBindings.getInputBindings!(jump)[0]).toMatchObject({
      Id: binding.Id,
      Key: "MouseLeft",
    });
    runtime.tick();
    expect(runtime.getResolvedInput().inputs.jump.held).toBe(true);
    expect(runtime.getLogRing().entries()).toHaveLength(2);
    runtime.pushInput([
      { kind: "gamepad", tick: 2, gamepadIndex: 2, axes: [], buttons: [1] },
    ]);
    runtime.tick();
    expect(runtime.inputBindings.getInputBindings!(jump)[0].Key).toBe(
      "Gamepad3Button0",
    );
    expect(runtime.getLogRing().entries().at(-1)?.message).toBe(
      "Gamepad3Button0",
    );
    runtime.stop();
  });

  it("adds axis options from a graph and restores exported modifications in another session", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      inputAssets: assets,
    });
    await load(
      runtime,
      [
        node("begin", "flow.event.beginPlay"),
        node("add", "input.addAxisBinding", {
          input: move,
          key: "KeyS",
          binding: { Component: "Y", DigitalValue: -1, Scale: 0.5 },
        }),
        node("remove", "input.removeAxisBinding", { input: move, key: "KeyW" }),
        node("export", "input.exportBindings"),
        node("log", "debug.log"),
      ],
      [
        edge("begin", "execOut", "add", "execIn"),
        edge("add", "execOut", "remove", "execIn"),
        edge("remove", "execOut", "log", "execIn"),
        edge("export", "data", "log", "message"),
      ],
    );
    runtime.start();
    runtime.pushInput([{ kind: "key", tick: 0, phase: "down", code: "KeyS" }]);
    runtime.tick();
    expect(runtime.getResolvedInput().inputs.move.value).toEqual({
      x: 0,
      y: -0.5,
    });
    const saved = runtime.getLogRing().entries().at(-1)!.message;
    runtime.stop();
    const restored = createInProcessRuntime({
      seed: 2,
      seedDemoActors: false,
      inputAssets: assets,
    });
    await load(
      restored,
      [
        node("begin", "flow.event.beginPlay"),
        node("import", "input.importBindings", { data: saved }),
      ],
      [edge("begin", "execOut", "import", "execIn")],
    );
    restored.start();
    restored.pushInputBuffer(
      encodeInputEvents([
        { kind: "key", tick: 0, phase: "down", code: "KeyS" },
        { kind: "key", tick: 0, phase: "down", code: "KeyW" },
      ]),
    );
    restored.tick();
    expect(restored.getResolvedInput().inputs.move.value).toEqual({
      x: 0,
      y: -0.5,
    });
    restored.stop();
  });
});
