import { afterEach, describe, expect, it } from "vitest";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { GlobalParameterSession, type GlobalParameterValueSource } from "./global-parameter-values";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** Defaults a test controls: `change` replaces one and notifies, like a collection edit. */
function defaults(initial: Record<string, number[]>) {
  const values = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  let revision = 0;
  const source: GlobalParameterValueSource & { change(key: string, value: number[]): void } = {
    get revision() { return revision; },
    value: (collectionGuid, parameterId) => values.get(`${collectionGuid}/${parameterId}`) ?? null,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    change(key, value) {
      values.set(key, value);
      revision += 1;
      for (const listener of listeners) listener();
    },
  };
  return source;
}

/** A Surface Material whose Base Color is a Global Parameter node's `pin`. */
function globalMaterial(properties: Record<string, unknown>, pin: string): MaterialDocument {
  const document = createDefaultMaterialDocument();
  document.nodes.push({ id: "global", type: "global.parameter", position: { x: 0, y: 0 }, properties });
  document.edges = [
    ...document.edges.filter((edge) => edge.targetPinId !== "baseColor"),
    { id: "global-base", sourceNodeId: "global", sourcePinId: pin, targetNodeId: "output", targetPinId: "baseColor" },
  ];
  return document;
}

function compile(document: MaterialDocument, source: GlobalParameterValueSource) {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "material:global", globalParameters: source });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const uniform = compiled.material.getInputBlocks().find((block) => block.valueCallback);
  if (!(uniform instanceof InputBlock)) throw new Error("No Global Parameter uniform");
  return uniform;
}

describe("Material Global Parameter uniform", () => {
  it("draws the session's value over the default and follows each change without a recompile", () => {
    const base = defaults({ "fx/tint": [0.2, 0.4, 0.6, 1] });
    const session = new GlobalParameterSession(base);
    const uniform = compile(globalMaterial({ collectionGuid: "fx", parameterId: "tint", valueType: "color" }, "rgb"), session);
    // A Color reads in linear space like a Color Parameter, from the block's own Color4.
    expect(uniform.convertToLinearSpace).toBe(true);
    const color = uniform.valueCallback!() as Color4;
    expect(color).toBe(uniform.value);
    expect(color.asArray()).toEqual([0.2, 0.4, 0.6, 1]);
    session.set("fx", "tint", [1, 0, 0, 0.5]);
    expect((uniform.valueCallback!() as Color4).asArray()).toEqual([1, 0, 0, 0.5]);
    expect(uniform.valueCallback!()).toBe(color);
    // Dropping the session's value returns to the default, which a collection edit changes.
    session.set("fx", "tint", null);
    base.change("fx/tint", [0, 1, 0, 1]);
    expect((uniform.valueCallback!() as Color4).asArray()).toEqual([0, 1, 0, 1]);
  });

  it("reads 0 for a parameter its source does not know and fits a value to the node's type", () => {
    const session = new GlobalParameterSession(defaults({}));
    const uniform = compile(globalMaterial({ collectionGuid: "fx", parameterId: "wind", valueType: "vec3" }, "out"), session);
    expect((uniform.valueCallback!() as Vector3).asArray()).toEqual([0, 0, 0]);
    // A wider value keeps its leading components.
    session.set("fx", "wind", [1, 2, 3, 4]);
    expect((uniform.valueCallback!() as Vector3).asArray()).toEqual([1, 2, 3]);
  });
});

describe("Global Parameter session", () => {
  it("notifies on its own changes and on default edits, and ignores dropping an unset value", () => {
    const base = defaults({ "fx/heat": [1] });
    const session = new GlobalParameterSession(base);
    let notified = 0;
    session.subscribe(() => { notified += 1; });
    const start = session.revision;
    session.set("fx", "heat", [Number.NaN]);
    expect(session.value("fx", "heat")).toEqual([0]);
    session.set("fx", "missing", null);
    expect(notified).toBe(1);
    base.change("fx/heat", [2]);
    expect(notified).toBe(2);
    expect(session.revision).toBe(start + 2);
    session.dispose();
    base.change("fx/heat", [3]);
    expect(notified).toBe(2);
  });
});
