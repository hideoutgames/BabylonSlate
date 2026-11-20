import type { SerializedGraph } from "../packages/core/src/index.ts";
import { GAIN_GUID } from "./scene-layer-post-process-graph";

export { GAIN_GUID };

/** The Post Processing Panel component's id on the panel actor's Class. */
export const PANEL_COMPONENT_ID = "pp";

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0) => ({ id, type, data, position: { x, y } });
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id: `${source}.${sourceHandle}>${target}.${targetHandle}`, source, sourceHandle, target, targetHandle });
const STEP = { variableName: "step", variableId: "var-step", scope: "member", implicitSelf: true, typeId: "int" };
/** The actor's own Post Processing Panel component. */
const PANEL = {
  variableName: "Post Processing Panel", scope: "member", implicitSelf: true, typeId: "object",
  typeClassId: "2DPostProcessingPanelComponent", componentId: PANEL_COMPONENT_ID,
};
/** A variable of that component, read or written through its Target pin, by its engine member id as the editor names it. */
const panelVariable = (variableName: string, propertyKey: string, typeId: string, typeClassId: string, extra: Record<string, unknown> = {}) => ({
  variableName, variableId: `engine:2DPostProcessingPanelComponent:var:${propertyKey}`, propertyKey, scope: "member", typeId, typeClassId,
  classId: "2DPostProcessingPanelComponent", ...extra,
});

/**
 * The panel actor's Class graph: Begin Play prints Panel ready, then each key press runs the next step. 0 gives the
 * panel the Gain Material (its pass starts at Gain 0.5), 1 writes Gain 1 through the panel's Material Object, 2
 * registers the same Material on the Scene Layer post-processing every layer shares, which runs over the layer, the
 * panel's result included.
 */
export const PANEL_STEPS_GRAPH = {
  members: [{ id: "var-step", kind: "variable", name: "step", typeId: "int", defaultValue: 0 }],
  nodes: [
    node("begin", "flow.event.beginPlay", {}, -700, -320),
    node("ready", "debug.print", { "default:value": "Panel ready", "default:key": "panel-ready", "default:duration": 60 }, -450, -320),
    node("key", "input.onAnyKeyPressed", {}, -700, 0),
    node("step", "variables.get", STEP, -700, 160),
    node("switch", "flow.switchInt", { cases: [0, 1, 2] }, -450, 0),
    node("panel", "variables.get", PANEL, -250, 320),
    node("set-material", "variables.set", panelVariable("Material", "materialGuid", "asset", "Material", { "default:value": GAIN_GUID }), 0, -220),
    node("step-1", "variables.set", { ...STEP, "default:value": 1 }, 250, -220),
    node("material-set", "debug.print", { "default:value": "Material set", "default:key": "material-set", "default:duration": 60 }, 500, -220),
    node("pass", "variables.get", panelVariable("Material Object", "materialObject", "object", "MaterialObject", { getOnly: true }), 0, 120),
    node("gain", "material.setFloatParameter", { "default:name": "Gain", "default:value": 1 }, 250, 0),
    node("step-2", "variables.set", { ...STEP, "default:value": 2 }, 500, 0),
    node("written", "debug.print", { "default:value": "Gain written", "default:key": "gain-written", "default:duration": 60 }, 750, 0),
    node("register", "scene-layer.registerPostProcess", { "default:material": GAIN_GUID }, 0, 260),
    node("step-3", "variables.set", { ...STEP, "default:value": 3 }, 250, 260),
    node("registered", "debug.print", { "default:value": "Pass registered", "default:key": "pass-registered", "default:duration": 60 }, 500, 260),
  ],
  edges: [
    edge("begin", "execOut", "ready", "execIn"),
    edge("key", "execOut", "switch", "execIn"),
    edge("step", "value", "switch", "value"),
    edge("switch", "case:0", "set-material", "execIn"),
    edge("panel", "value", "set-material", "target"),
    edge("set-material", "execOut", "step-1", "execIn"),
    edge("step-1", "execOut", "material-set", "execIn"),
    edge("switch", "case:1", "gain", "execIn"),
    edge("panel", "value", "pass", "target"),
    edge("pass", "value", "gain", "material"),
    edge("gain", "execOut", "step-2", "execIn"),
    edge("step-2", "execOut", "written", "execIn"),
    edge("switch", "case:2", "register", "execIn"),
    edge("register", "execOut", "step-3", "execIn"),
    edge("step-3", "execOut", "registered", "execIn"),
  ],
} as unknown as SerializedGraph;
