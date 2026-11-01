import { CURVE_OBJECT_CLASS_IDS, normalizeCurve, type Curve, type CurveKind } from "@haptic/core";
import { EngineObject } from "./objects";

/**
 * The read-only object scripts get for a Float, Vector or Color Curve asset (`Get <Type> Curve Object`).
 * The script host keeps one per asset for the session and never registers it for collection, so it can
 * be passed into functions and stored freely. It holds no variables; its read nodes go through `ctx`.
 */
export class CurveObject extends EngineObject {
  readonly kind: CurveKind;
  readonly assetGuid: string;
  #curve: Curve<unknown>;

  constructor(kind: CurveKind, assetGuid: string, curve: unknown) {
    super({ classId: CURVE_OBJECT_CLASS_IDS[kind], guid: `${assetGuid}:curve-object` });
    this.kind = kind;
    this.assetGuid = assetGuid;
    this.#curve = normalizeCurve(kind, curve) as Curve<unknown>;
  }

  /** The asset's curve, keys sorted. Callers must not mutate it; copy it to hand it to a script. */
  get curve(): Curve<unknown> {
    return this.#curve;
  }

  /** The host swaps in a reloaded payload; the object keeps its identity. */
  replaceCurve(curve: unknown): void {
    this.#curve = normalizeCurve(this.kind, curve) as Curve<unknown>;
  }
}
