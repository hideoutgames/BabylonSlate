import { CUSTOM_EASING_CURVE_SAMPLES } from "@haptic/core";
import {
  CUSTOM_EASING_CURVE_CLASS_ID, CUSTOM_EASING_CURVE_EVALUATE_FUNCTION, type ClassRegistry, type EngineObject,
} from "@haptic/object-model";
import { jsIdent } from "@haptic/scripting";

/** Evaluate's compiled export name. */
export const EVALUATE_EXPORT = jsIdent(CUSTOM_EASING_CURVE_EVALUATE_FUNCTION.name);
const ALPHA_INPUT = CUSTOM_EASING_CURVE_EVALUATE_FUNCTION.pins.find((pin) => pin.direction === "in" && pin.typeId !== "exec")!.name;
const VALUE_OUTPUT = CUSTOM_EASING_CURVE_EVALUATE_FUNCTION.pins.find((pin) => pin.direction === "out" && pin.typeId !== "exec")!.name;
const SEGMENTS = CUSTOM_EASING_CURVE_SAMPLES - 1;

/** What baking needs from the session: its classes, a bare instance, and a call of the instance's Evaluate. */
export interface CustomEasingCurveBakeHost {
  classes(): Pick<ClassRegistry, "classIds" | "isA">;
  /** A new instance of `classId` with its Class defaults; no lifecycle event runs on it. */
  createInstance(classId: string): EngineObject;
  /** Evaluate's outputs (export `EVALUATE_EXPORT`) by output pin name; null when it is missing, throws or waits. */
  evaluate(self: EngineObject, args: Record<string, unknown>): Record<string, unknown> | null;
  /** Done with an instance: it is never used again. */
  release(self: EngineObject): void;
}

/**
 * One baked table: Evaluate at Alpha i / 128 for i 0 to 128. A sample that is missing or not a finite number is its
 * Alpha (Linear). After a call with no result (no Evaluate, an error, or a latent Evaluate) the rest are Linear too, so
 * a broken curve reports once, not 129 times.
 */
function bakeTable(host: CustomEasingCurveBakeHost, self: EngineObject): number[] {
  const table = new Array<number>(CUSTOM_EASING_CURVE_SAMPLES);
  let calling = true;
  for (let index = 0; index < CUSTOM_EASING_CURVE_SAMPLES; index++) {
    const alpha = index / SEGMENTS;
    const outputs = calling ? host.evaluate(self, { [ALPHA_INPUT]: alpha }) : null;
    if (outputs === null) calling = false;
    const value = outputs?.[VALUE_OUTPUT];
    table[index] = typeof value === "number" && Number.isFinite(value) ? value : alpha;
  }
  return table;
}

/**
 * Bakes every loaded Class deriving from Custom Easing Curve (not the base itself) by Class id, in sorted id order so
 * the bake is deterministic. Each gets one instance for its 129 Evaluate calls, released afterwards; a Class that
 * does not override Evaluate runs its parent's. Every load bakes every curve again: Evaluate may call other Classes
 * whose sources changed.
 */
export function bakeCustomEasingCurves(host: CustomEasingCurveBakeHost): Record<string, number[]> {
  const classes = host.classes();
  const curves: Record<string, number[]> = {};
  const classIds = classes.classIds()
    .filter((classId) => classId !== CUSTOM_EASING_CURVE_CLASS_ID && classes.isA(classId, CUSTOM_EASING_CURVE_CLASS_ID))
    .sort();
  for (const classId of classIds) {
    const self = host.createInstance(classId);
    try {
      curves[classId] = bakeTable(host, self);
    } finally {
      host.release(self);
    }
  }
  return curves;
}
