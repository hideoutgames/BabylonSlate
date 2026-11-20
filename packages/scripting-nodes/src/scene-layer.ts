import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
  assetRef,
  objectRef,
} from "@haptic/scripting";
import { selfActorPin, subject } from "./self-pin";

const LAYER = objectRef("SceneLayer");
const SCENE_LAYER_ASSET = assetRef("SceneLayer");
const MATERIAL_ASSET = assetRef("Material");
export const sceneLayerNodes: NodeDefinition[] = [
  {
    id: "scene-layer.create",
    title: "Create Scene Layer",
    category: "scene-layer",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "Asset", "in", SCENE_LAYER_ASSET),
      pin("zOrder", "Z-Order", "in", INT),
      pin("out", "Layer", "out", LAYER),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = (yield ctx.createSceneLayerAsync(${ctx.input("asset")}, ${ctx.input("zOrder")}));`,
      );
    },
  },
  {
    id: "scene-layer.remove",
    title: "Remove Scene Layer",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.removeSceneLayer(${ctx.input("layer")});`);
    },
  },
  {
    id: "scene-layer.clear",
    title: "Clear Scene Layer",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.clearSceneLayers();`);
    },
  },
  {
    id: "scene-layer.registerPostProcess",
    title: "Register Scene Layer Post-Processing",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("material", "Material", "in", MATERIAL_ASSET),
      pin("pass", "Pass", "out", objectRef("MaterialObject")),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("pass")} = ctx.registerSceneLayerPostProcess(${ctx.input("layer")}, ${ctx.input("material")});`,
      );
    },
  },
  {
    id: "scene-layer.unregisterPostProcess",
    title: "Unregister Scene Layer Post-Processing",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("material", "Material", "in", MATERIAL_ASSET),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.unregisterSceneLayerPostProcess(${ctx.input("layer")}, ${ctx.input("material")});`,
      );
    },
  },
  {
    id: "scene-layer.getOwningSceneLayer",
    title: "Get Owning Scene Layer",
    category: "scene-layer",
    pure: true,
    pins: () => [
      selfActorPin("actor", "Actor"),
      pin("out", "Layer", "out", LAYER),
    ],
    codegen: (ctx) => ({
      out: `ctx.getOwningSceneLayer(${ctx.input("actor")})`,
    }),
  },
];
