/**
 * Script graph conversions: a wire from an Actor or component reference into a Vector3, Rotator, Transform or
 * String input inserts the getter that reads that value (`GraphEditor.pinConversion`). The inserted node is an
 * ordinary catalog node; the type system never converts implicitly.
 */
import { TRANSFORMLESS_COMPONENT_CLASS_IDS } from "@haptic/core";
import { pinTypeDisplayName, type PaletteNode, type PinConversion, type SerializedPin } from "@haptic/graph-ui";
import type { ClassHierarchy } from "@haptic/scripting";

type ConvertedKind = "vec3" | "rotator" | "transform" | "string";
type Converter = { nodeType: string; inPinId: string; outPinId: string };

const ACTOR_CONVERTERS: Record<ConvertedKind, Converter> = {
  vec3: { nodeType: "transform.getLocation", inPinId: "target", outPinId: "out" },
  rotator: { nodeType: "transform.getRotation", inPinId: "target", outPinId: "out" },
  transform: { nodeType: "transform.get", inPinId: "target", outPinId: "out" },
  string: { nodeType: "actor.getName", inPinId: "target", outPinId: "out" },
};

const COMPONENT_CONVERTERS: Record<ConvertedKind, Converter> = {
  vec3: { nodeType: "transform.getComponentWorldLocation", inPinId: "target", outPinId: "out" },
  rotator: { nodeType: "transform.getComponentWorldRotation", inPinId: "target", outPinId: "out" },
  transform: { nodeType: "transform.getComponentWorldTransform", inPinId: "target", outPinId: "out" },
  string: { nodeType: "object.getDisplayName", inPinId: "object", outPinId: "name" },
};

const TRANSFORMLESS_BASES = [...TRANSFORMLESS_COMPONENT_CLASS_IDS];

function isConvertedKind(kind: string): kind is ConvertedKind {
  return kind === "vec3" || kind === "rotator" || kind === "transform" || kind === "string";
}

export type ScriptPinConversionOptions = {
  hierarchy: ClassHierarchy;
  /** The Add Node row of a catalog node type, as the palette builds it. Asked once per type. */
  paletteNodeFor: (nodeType: string) => PaletteNode | undefined;
};

/** The Script graph host's `GraphEditor.pinConversion`. Each converter's row is built once and then reused. */
export function scriptPinConversion({
  hierarchy,
  paletteNodeFor,
}: ScriptPinConversionOptions): (source: SerializedPin, target: SerializedPin) => PinConversion | null {
  const rows = new Map<string, PaletteNode | undefined>();
  const rowFor = (nodeType: string) => {
    if (!rows.has(nodeType)) rows.set(nodeType, paletteNodeFor(nodeType));
    return rows.get(nodeType);
  };
  const isA = (classId: string, base: string) => classId === base || hierarchy.isSubclassOf(classId, base);
  // A user subclass of a transform-less engine component has no transform either.
  const hasTransform = (classId: string) => !TRANSFORMLESS_BASES.some((base) => isA(classId, base));
  return (source, target) => {
    const targetKind = target.type.kind;
    if (source.type.kind !== "objectRef" || !isConvertedKind(targetKind)) return null;
    const classId = typeof source.type.classId === "string" ? source.type.classId : "";
    if (!classId) return null;
    let converter: Converter | undefined;
    if (isA(classId, "Actor")) {
      converter = ACTOR_CONVERTERS[targetKind];
    } else if (isA(classId, "ActorComponent")) {
      if (targetKind !== "string" && !hasTransform(classId)) return null;
      converter = COMPONENT_CONVERTERS[targetKind];
    }
    if (!converter) return null;
    const paletteNode = rowFor(converter.nodeType);
    if (!paletteNode) return null;
    return {
      label: `Convert to ${pinTypeDisplayName(target.type)}`,
      paletteNode,
      inPinId: converter.inPinId,
      outPinId: converter.outPinId,
    };
  };
}
