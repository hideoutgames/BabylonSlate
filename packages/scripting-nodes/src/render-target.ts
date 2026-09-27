import { ENGINE_RENDER_TARGET_MODE_ENUM_ID, type RenderTargetCaptureProperty } from "@babylonslate/core";
import {
  actorRef, arrayOf, assetRef, BOOL, enumRef, EXEC, FLOAT, pin,
  type NodeDefinition, type PinType,
} from "@babylonslate/scripting";

const CAPTURE = actorRef("RenderTargetCapture");

function propertyNodes(
  suffix: string,
  label: string,
  key: RenderTargetCaptureProperty,
  type: PinType,
): NodeDefinition[] {
  return [{
    id: `render-target.get${suffix}`,
    title: `Get Capture ${label}`,
    category: "render",
    pure: true,
    pins: () => [pin("capture", "Capture", "in", CAPTURE), pin("value", label, "out", type)],
    codegen: (ctx) => ({ [label]: `ctx.getRenderTargetCaptureProperty(${ctx.input("Capture")}, ${JSON.stringify(key)})` }),
  }, {
    id: `render-target.set${suffix}`,
    title: `Set Capture ${label}`,
    category: "render",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC),
      pin("capture", "Capture", "in", CAPTURE), pin("value", label, "in", type),
    ],
    codegen: (ctx) => ctx.emit(`ctx.setRenderTargetCaptureProperty(${ctx.input("Capture")}, ${JSON.stringify(key)}, ${ctx.input(label)});`),
  }];
}

export const renderTargetNodes: NodeDefinition[] = [
  {
    id: "render-target.getMode",
    title: "Get Render Target Mode",
    category: "render",
    pure: true,
    pins: () => [
      pin("target", "Render Target", "in", assetRef("RenderTarget")),
      pin("mode", "Mode", "out", enumRef(ENGINE_RENDER_TARGET_MODE_ENUM_ID)),
    ],
    codegen: (ctx) => ({ Mode: `ctx.getRenderTargetMode(${ctx.input("Render Target")})` }),
  },
  {
    id: "render-target.getTextureTarget",
    title: "Get Texture Render Target",
    category: "render",
    pure: true,
    pins: () => [
      pin("texture", "Texture", "in", assetRef("RenderTargetTexture")),
      pin("target", "Render Target", "out", assetRef("RenderTarget")),
    ],
    codegen: (ctx) => ({ "Render Target": `ctx.getRenderTargetTextureTarget(${ctx.input("Texture")})` }),
  },
  {
    id: "render-target.capture",
    title: "Capture Render Target",
    category: "render",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC), pin("execOut", "Then", "out", EXEC),
      pin("capture", "Capture", "in", CAPTURE),
    ],
    codegen: (ctx) => ctx.emit(`ctx.captureRenderTarget(${ctx.input("Capture")});`),
  },
  ...propertyNodes("RenderTarget", "Render Target", "renderTargetGuid", assetRef("RenderTarget")),
  ...propertyNodes("Enabled", "Enabled", "enabled", BOOL),
  ...propertyNodes("EveryFrame", "Every Frame", "captureEveryFrame", BOOL),
  ...propertyNodes("OnlyActors", "Only Actors", "captureOnlyActors", BOOL),
  ...propertyNodes("Actors", "Actors", "actorIds", arrayOf(actorRef("Actor"))),
  ...propertyNodes("FieldOfView", "Field Of View", "fieldOfView", FLOAT),
  ...propertyNodes("NearClip", "Near Clip", "nearClip", FLOAT),
  ...propertyNodes("FarClip", "Far Clip", "farClip", FLOAT),
];
