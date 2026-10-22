import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  INT,
  VEC2,
  assetRef,
  objectRef,
  diagnostic,
  listValidationRules,
  registerValidationRule,
  readPinDefault,
  type TypeContext,
  type LogicGraph,
} from "@haptic/scripting";
import { selfActorPin, subject } from "./self-pin";

const LAYER = objectRef("SceneLayer");
const SCENE_LAYER_ASSET = assetRef("SceneLayer");
const MATERIAL_ASSET = assetRef("Material");
const POST_PROCESS_NODE_IDS = new Set([
  "scene-layer.registerPostProcess",
  "scene-layer.unregisterPostProcess",
]);

function materialGuidFromNode(node: {
  properties: Record<string, unknown>;
}): string | undefined {
  const raw = readPinDefault(node.properties, "material");
  if (typeof raw !== "string") return undefined;
  const guid = raw.trim();
  return guid.length > 0 ? guid : undefined;
}

function validatePostProcessDomain(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
) {
  const domains = ctx.materialDomains;
  if (!domains) return [];
  const out = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (!POST_PROCESS_NODE_IDS.has(node.typeId)) continue;
      const guid = materialGuidFromNode(node);
      if (!guid) continue;
      const domain = domains[guid];
      if (!domain || domain === "postProcess") continue;
      out.push(
        diagnostic({
          code: "scene-layer.postProcessDomain",
          message: `SceneLayer post-process requires a postProcess Material (got ${domain})`,
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
          pinId: "material",
        }),
      );
    }
  }
  return out;
}

export function registerSceneLayerValidationRules(): void {
  if (listValidationRules().some((rule) => rule.id === "scene-layer.postProcessDomain")) {
    return;
  }
  registerValidationRule({
    id: "scene-layer.postProcessDomain",
    run: validatePostProcessDomain,
  });
}

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
        `${out} = await ctx.createSceneLayerAsync(${ctx.input("asset")}, ${ctx.input("zOrder")});`,
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
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.registerSceneLayerPostProcess(${ctx.input("layer")}, ${ctx.input("material")});`,
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
  {
    id: "scene-layer.setCameraLocation",
    title: "Set Scene Layer Camera Location",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("location", "Location", "in", VEC2),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setSceneLayerCameraLocation(${ctx.input("layer")}, ${ctx.input("location")});`);
    },
  },
  {
    id: "scene-layer.addCameraOffset",
    title: "Add Scene Layer Camera Offset",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("delta", "Delta", "in", VEC2),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.addSceneLayerCameraOffset(${ctx.input("layer")}, ${ctx.input("delta")});`);
    },
  },
  {
    id: "scene-layer.getCameraLocation",
    title: "Get Scene Layer Camera Location",
    category: "scene-layer",
    pure: true,
    pins: () => [
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("out", "Location", "out", VEC2),
    ],
    codegen: (ctx) => ({
      out: `ctx.getSceneLayerCameraLocation(${ctx.input("layer")})`,
    }),
  },
  {
    id: "scene-layer.setCameraRotation",
    title: "Set Scene Layer Camera Rotation",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("rotation", "Rotation", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setSceneLayerCameraRotation(${ctx.input("layer")}, ${ctx.input("rotation")});`);
    },
  },
  {
    id: "scene-layer.getCameraRotation",
    title: "Get Scene Layer Camera Rotation",
    category: "scene-layer",
    pure: true,
    pins: () => [
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("out", "Rotation", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.getSceneLayerCameraRotation(${ctx.input("layer")})`,
    }),
  },
  {
    id: "scene-layer.setCameraZoom",
    title: "Set Scene Layer Camera Zoom",
    category: "scene-layer",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("zoom", "Zoom", "in", FLOAT, "data", true, 1),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setSceneLayerCameraZoom(${ctx.input("layer")}, ${ctx.input("zoom")});`);
    },
  },
  {
    id: "scene-layer.getCameraZoom",
    title: "Get Scene Layer Camera Zoom",
    category: "scene-layer",
    pure: true,
    pins: () => [
      subject(pin("layer", "Layer", "in", LAYER)),
      pin("out", "Zoom", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.getSceneLayerCameraZoom(${ctx.input("layer")})`,
    }),
  },
];
