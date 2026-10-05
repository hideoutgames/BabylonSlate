import {
  isOverlayLayoutClass, parseOverlayLayoutProperties, supportsOverlayVisualStyle,
  type TweenValueType,
} from "@babylonslate/core";
import { Actor, ActorComponent, BObject, engineScriptApiFor } from "@babylonslate/object-model";
import type { ScriptHostServices } from "./script-host";
import type { TweenReference } from "./tween-runtime";
import { applyTweenTransform, type TweenTransformChannel } from "./tween-transforms";

const textClasses = new Set(["2DTextComponent", "2DRichTextComponent"]);
const transformChannels = ["position", "rotation", "scale", "transform"] as const;
const propertyTypes: Record<string, TweenValueType> = {
  "overlay.opacity": "float", "overlay.tint": "color", "anchor.offset": "vec2",
  "scroll.offset": "vec2", "layout.size": "vec2", "text.fontSize": "float",
  "text.color": "color", "text.outline": "float", "text.outlineColor": "color", "text.wrapSize": "vec2",
};

/** Preserve native array storage while user variables retain their authored value shape. */
export function tweenStorageValue(target: BObject, key: string, value: unknown): unknown {
  if (key === "opacity" && supportsOverlayVisualStyle(target.classId) && typeof value === "number") {
    return Math.min(1, Math.max(0, value));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const native = engineScriptApiFor(target.classId)?.variables?.find((entry) => entry.propertyKey === key);
  const previous = target.getVariable(key);
  if (native?.typeId === "color" || Array.isArray(previous)) {
    const count = Array.isArray(previous) ? previous.length :
      key === "color" || key === "outlineColor" ? 3 : 4;
    if (["x", "y", "z", "w"].slice(0, count).every((axis) => typeof v[axis] === "number")) {
      return [v.x, v.y, v.z, v.w].slice(0, count);
    }
  }
  return value;
}

export function isReadOnlyTweenProperty(target: BObject, key: string): boolean {
  return engineScriptApiFor(target.classId)?.variables?.some((entry) => entry.propertyKey === key && entry.getOnly) === true;
}

/** Bind a named operation once, while reading its live parent/layout on each write. */
export function propertyTweenReference(
  target: unknown, property: string, type: TweenValueType, space: unknown, services: ScriptHostServices,
): TweenReference | null {
  const [kind, channel] = property.split(".");
  if ((kind === "actor" || kind === "component") && transformChannels.includes(channel as TweenTransformChannel)) {
    if (kind === "actor" ? !(target instanceof Actor) : !(target instanceof ActorComponent)) return null;
    const object = target as Actor | ActorComponent;
    const expected = channel === "rotation" ? "rotator" : channel === "transform" ? "transform" : "vec3";
    if (type !== expected) return null;
    return {
      identity: object, property, owner: object,
      channels: (channel === "transform" ? ["position", "rotation", "scale"] : [channel!]).map((name) => `transform:${name}`),
      set(value) {
        if (!applyTweenTransform(object, channel as TweenTransformChannel, value,
          space === "world" || space === 1 ? "world" : "local", (id) => services.findActor?.(id))) return false;
        if (object instanceof Actor) services.teleportActor?.(object);
        else services.refreshComponent?.(object, "transform");
      },
    };
  }
  if (!(target instanceof ActorComponent) || propertyTypes[property] !== type) return null;
  let keys: string[];
  switch (property) {
    case "overlay.opacity": case "overlay.tint":
      if (!supportsOverlayVisualStyle(target.classId)) return null;
      keys = [property === "overlay.opacity" ? "opacity" : "tint"];
      break;
    case "anchor.offset":
      if (target.classId !== "2DAnchorComponent") return null;
      keys = ["offsetX", "offsetY"];
      break;
    case "scroll.offset":
      if (target.classId !== "2DScrollBoxComponent") return null;
      keys = ["scrollX", "scrollY"];
      break;
    case "layout.size":
      if (!isOverlayLayoutClass(target.classId) || target.classId === "2DPaddingComponent") return null;
      {
        const layout = parseOverlayLayoutProperties(Object.fromEntries(target.variables), target.classId);
        if (layout.widthMode !== "fixed" && layout.heightMode !== "fixed") return null;
      }
      keys = ["width", "height"];
      break;
    default:
      if (!textClasses.has(target.classId)) return null;
      keys = property === "text.wrapSize" ? ["wrapWidth", "wrapHeight"] :
        [property === "text.fontSize" ? "size" : property.slice(5)];
  }
  return {
    identity: target, property, owner: target, channels: keys.map((key) => `variable:${key}`),
    set(value) {
      if (keys.length === 2) {
        const vector = value as { x: number; y: number };
        const dimensions = [vector.x, vector.y];
        const layout = property === "layout.size" ? parseOverlayLayoutProperties(Object.fromEntries(target.variables), target.classId) : null;
        if (layout && layout.widthMode !== "fixed" && layout.heightMode !== "fixed") return false;
        for (let index = 0; index < 2; index++) {
          if (layout && (index === 0 ? layout.widthMode : layout.heightMode) !== "fixed") continue;
          target.setVariable(keys[index]!, property === "anchor.offset" ? dimensions[index] : Math.max(0, dimensions[index]!));
        }
      } else {
        const key = keys[0]!;
        const normalized = key === "opacity" ? Math.min(1, Math.max(0, value as number)) :
          key === "size" ? Math.max(Number.EPSILON, value as number) :
          key === "outline" ? Math.max(0, value as number) : value;
        target.setVariable(key, tweenStorageValue(target, key, normalized));
      }
      services.refreshComponent?.(target, keys.length === 1 ? keys[0] : property);
    },
  };
}
