import { expect, it } from "vitest";
import { compileGraph, type GraphNode } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

const outgoingActor = { id: "outgoing" };
const incomingActor = { id: "incoming" };
const switcher = { id: "switcher" };
const cases: Array<{ eventType: string; event: string; args: Record<string, unknown>; values: unknown[]; componentId?: string }> = [
  { eventType: "uiValueChanged", event: "onUIValueChanged", args: { value: 0.75 }, values: [0.75], componentId: "slider" },
  { eventType: "uiRangeChanged", event: "onUIRangeChanged", args: { lowerValue: 2, upperValue: 8 }, values: [2, 8], componentId: "range" },
  { eventType: "uiCheckedChanged", event: "onUICheckedChanged", args: { checked: false }, values: [false], componentId: "checkbox" },
  { eventType: "uiTextChanged", event: "onUITextChanged", args: { text: "Edited" }, values: ["Edited"], componentId: "input" },
  { eventType: "uiTextSubmitted", event: "onUITextSubmitted", args: { text: "Submitted" }, values: ["Submitted"], componentId: "input" },
  { eventType: "uiSelectionChanged", event: "onUISelectionChanged", args: { index: 1, value: "Hard" }, values: [1, "Hard"], componentId: "dropdown" },
  { eventType: "sceneLayerActorSwitching", event: "onSceneLayerActorSwitching", args: { previousActor: outgoingActor, currentActor: outgoingActor, previousIndex: 0, index: 1 }, values: [outgoingActor, outgoingActor, 0, 1] },
  { eventType: "sceneLayerActorSwitched", event: "onSceneLayerActorSwitched", args: { previousActor: outgoingActor, currentActor: incomingActor, previousIndex: 0, index: 1 }, values: [outgoingActor, incomingActor, 0, 1] },
  { eventType: "sceneLayerActorSwitchedTo", event: "onSceneLayerActorSwitchedTo", args: { switcher, index: 1 }, values: [switcher, 1] },
  { eventType: "sceneLayerActorSwitchedFrom", event: "onSceneLayerActorSwitchedFrom", args: { switcher, index: 0 }, values: [switcher, 0] },
  { eventType: "focusActivate", event: "onFocusActivate", args: {}, values: [], componentId: "checkbox" },
];

it.each(cases)("compiles $event with live payload values and the correct component binding", ({ eventType, event, args, values, componentId }) => {
  const registry = createDefaultNodeRegistry();
  const typeId = `flow.event.${eventType}`;
  const properties = componentId ? { componentId } : {};
  const pins = registry.get(typeId)!.pins(properties);
  const dataPins = pins.filter((pin) => pin.type.kind !== "exec");
  const entry: GraphNode = { id: "event", typeId, position: { x: 0, y: 0 }, pins, properties };
  const sinkProperties = {
    inputs: dataPins.map((pin) => ({ name: pin.id, type: pin.type })),
    body: `ctx.received = [${dataPins.map((pin) => pin.id).join(", ")}];`,
  };
  const sink: GraphNode = { id: "sink", typeId: "debug.executeJavaScript", position: { x: 300, y: 0 },
    pins: registry.get("debug.executeJavaScript")!.pins(sinkProperties), properties: sinkProperties };
  const compiled = compileGraph({ id: "control-event", kind: "event", nodes: [entry, sink], edges: [
    { id: "exec", sourceNodeId: "event", sourcePinId: "execOut", targetNodeId: "sink", targetPinId: "execIn" },
    ...dataPins.map((pin) => ({ id: pin.id, sourceNodeId: "event", sourcePinId: pin.id, targetNodeId: "sink", targetPinId: `in_${pin.id}` })),
  ] }, { assetGuid: "controls", registry });
  expect(compiled.entryPoints[0]).toMatchObject({ event, ...(componentId ? { componentId } : {}) });
  const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const run = new Function(`${body}\nreturn ${compiled.entryPoints[0]!.name};`)() as (ctx: unknown) => void;
  const context = { args, received: undefined as unknown };
  run(context);
  expect(context.received).toEqual(values);
});
