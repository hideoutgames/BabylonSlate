import type { SerializedGraph } from "../packages/core/src/index.ts";

/** The post-process Material the steps register: it scales colour and alpha by its Gain parameter. */
export const GAIN_GUID = "00000000-0000-4000-8000-000000000055";

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0) => ({ id, type, data, position: { x, y } });
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id: `${source}.${sourceHandle}>${target}.${targetHandle}`, source, sourceHandle, target, targetHandle });
const member = (name: string, typeId: string, extra: Record<string, unknown> = {}) =>
  ({ variableName: name, variableId: `var-${name}`, scope: "member", implicitSelf: true, typeId, ...extra });
const PASS = member("pass", "object", { typeClassId: "MaterialObject" });
const STEP = member("step", "int");

/**
 * The back layer's actor: each key press runs the next step. 0 registers the Gain pass on the Scene Layer
 * post-processing (keeping its Material Object), 1 writes its Gain parameter, 2 unregisters it.
 */
export const STEPS_GRAPH = {
  members: [
    { id: "var-step", kind: "variable", name: "step", typeId: "int", defaultValue: 0 },
    { id: "var-pass", kind: "variable", name: "pass", typeId: "object", typeClassId: "MaterialObject" },
  ],
  nodes: [
    node("key", "input.onAnyKeyPressed", {}, -600, 0),
    node("step", "variables.get", STEP, -600, 160),
    node("switch", "flow.switchInt", { cases: [0, 1, 2] }, -350, 0),
    node("register", "scene-layer.registerPostProcess", { "default:material": GAIN_GUID }, 0, -200),
    node("keep-pass", "variables.set", PASS, 250, -200),
    node("step-1", "variables.set", { ...STEP, "default:value": 1 }, 500, -200),
    node("registered", "debug.print", { "default:value": "Pass registered", "default:key": "pass-registered", "default:duration": 60 }, 750, -200),
    node("pass", "variables.get", PASS, 0, 120),
    node("gain", "material.setFloatParameter", { "default:name": "Gain", "default:value": 1 }, 250, 0),
    node("step-2", "variables.set", { ...STEP, "default:value": 2 }, 500, 0),
    node("written", "debug.print", { "default:value": "Gain written", "default:key": "gain-written", "default:duration": 60 }, 750, 0),
    node("unregister", "scene-layer.unregisterPostProcess", { "default:material": GAIN_GUID }, 0, 200),
    node("step-3", "variables.set", { ...STEP, "default:value": 3 }, 500, 200),
    node("unregistered", "debug.print", { "default:value": "Pass unregistered", "default:key": "pass-unregistered", "default:duration": 60 }, 750, 200),
  ],
  edges: [
    edge("key", "execOut", "switch", "execIn"),
    edge("step", "value", "switch", "value"),
    edge("switch", "case:0", "register", "execIn"),
    edge("register", "execOut", "keep-pass", "execIn"),
    edge("register", "pass", "keep-pass", "value"),
    edge("keep-pass", "execOut", "step-1", "execIn"),
    edge("step-1", "execOut", "registered", "execIn"),
    edge("switch", "case:1", "gain", "execIn"),
    edge("pass", "value", "gain", "material"),
    edge("gain", "execOut", "step-2", "execIn"),
    edge("step-2", "execOut", "written", "execIn"),
    edge("switch", "case:2", "unregister", "execIn"),
    edge("unregister", "execOut", "step-3", "execIn"),
    edge("step-3", "execOut", "unregistered", "execIn"),
  ],
} as unknown as SerializedGraph;

