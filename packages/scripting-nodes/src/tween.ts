import {
  pin, EXEC, FLOAT, INT, VEC2, VEC3, VEC4, ROTATOR, QUAT, COLOR, TRANSFORM,
  actorRef, objectRef, enumRef, defaultJsValue,
  ENGINE_EASING_CURVE_ENUM_ID, ENGINE_TWEEN_SPACE_ENUM_ID,
  type NodeDefinition, type PinType,
} from "@babylonslate/scripting";

const curve = enumRef(ENGINE_EASING_CURVE_ENUM_ID);
const space = enumRef(ENGINE_TWEEN_SPACE_ENUM_ID);
const actor = actorRef("Actor");
const component = objectRef("ActorComponent");
const identityTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
};

function tweenNode(
  id: string, title: string, value: PinType, target?: PinType,
  property?: string, transformSpace = false,
): NodeDefinition {
  return {
    id: `tween.${id}`, title: `Tween ${title}`, category: "tween", latent: true,
    description: target
      ? "Interpolates the target property from A to B over Duration seconds. Completed runs only after reaching B."
      : "Connect a writable variable Get to Target. Writes A to B over Duration seconds; Completed runs only after reaching B.",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Completed", "out", EXEC),
      { ...pin("target", "Target", "in", target ?? value), ...(!target ? { reference: "required" as const } : {}) },
      pin("a", "A", "in", value, "data", true, value.kind === "transform" ? identityTransform : defaultJsValue(value)),
      pin("b", "B", "in", value, "data", true, value.kind === "transform" ? identityTransform : defaultJsValue(value)),
      pin("duration", "Duration", "in", FLOAT, "data", true, 2),
      pin("curve", "Curve", "in", curve, "data", true, "linear"),
      ...(transformSpace ? [pin("space", "Space", "in", space, "data", true, "local")] : []),
    ],
    codegen: (ctx) => {
      if (!ctx.continueIf || (!target && !ctx.reference)) {
        throw new Error("Tween nodes require a compiler with writable references and conditional latent completion");
      }
      const args = `${JSON.stringify(value.kind)}, ${ctx.input("a")}, ${ctx.input("b")}, ${ctx.input("duration")}, ${ctx.input("curve")}`;
      const call = target
        ? `ctx.tweenProperty(${ctx.input("target")}, ${JSON.stringify(property)}, ${args}${transformSpace ? `, ${ctx.input("space")}` : ""})`
        : `ctx.tweenValue(${ctx.reference!("target")}, ${args})`;
      ctx.continueIf(`await ${call}`);
    },
  };
}

export const tweenNodes: NodeDefinition[] = [
  tweenNode("float", "Float", FLOAT),
  tweenNode("integer", "Integer", INT),
  tweenNode("vector2", "Vector2", VEC2),
  tweenNode("vector3", "Vector3", VEC3),
  tweenNode("vector4", "Vector4", VEC4),
  tweenNode("rotator", "Rotator", ROTATOR),
  tweenNode("quaternion", "Quaternion", QUAT),
  tweenNode("color", "Color", COLOR),
  tweenNode("transform", "Transform", TRANSFORM),
  tweenNode("actorPosition", "Actor Position", VEC3, actor, "actor.position", true),
  tweenNode("actorRotation", "Actor Rotation", ROTATOR, actor, "actor.rotation", true),
  tweenNode("actorScale", "Actor Scale", VEC3, actor, "actor.scale", true),
  tweenNode("actorTransform", "Actor Transform", TRANSFORM, actor, "actor.transform", true),
  tweenNode("componentPosition", "Component Position", VEC3, component, "component.position", true),
  tweenNode("componentRotation", "Component Rotation", ROTATOR, component, "component.rotation", true),
  tweenNode("componentScale", "Component Scale", VEC3, component, "component.scale", true),
  tweenNode("componentTransform", "Component Transform", TRANSFORM, component, "component.transform", true),
  tweenNode("opacity", "2D Opacity", FLOAT, component, "overlay.opacity"),
  tweenNode("tint", "2D Tint", COLOR, component, "overlay.tint"),
  tweenNode("anchorOffset", "Anchor Offset", VEC2, objectRef("2DAnchorComponent"), "anchor.offset"),
  tweenNode("scrollOffset", "Scroll Offset", VEC2, objectRef("2DScrollBoxComponent"), "scroll.offset"),
  tweenNode("layoutSize", "Layout Size", VEC2, component, "layout.size"),
  tweenNode("textFontSize", "Text Font Size", FLOAT, component, "text.fontSize"),
  tweenNode("textColor", "Text Color", COLOR, component, "text.color"),
  tweenNode("textOutline", "Text Outline", FLOAT, component, "text.outline"),
  tweenNode("textOutlineColor", "Text Outline Color", COLOR, component, "text.outlineColor"),
  tweenNode("textWrapSize", "Text Wrap Size", VEC2, component, "text.wrapSize"),
];
