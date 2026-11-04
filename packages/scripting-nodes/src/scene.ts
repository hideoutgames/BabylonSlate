import {
  pin,
  type NodeDefinition,
  EXEC,
  assetRef,
  objectRef,
} from "@haptic/scripting";

const SCENE_ASSET = assetRef("Scene");
const MATERIAL_ASSET = assetRef("Material");
const MATERIAL_OBJECT = objectRef("MaterialObject");

export const sceneNodes: NodeDefinition[] = [
  {
    id: "scene.change",
    title: "Change Scene",
    category: "scene",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("scene", "scene", "in", SCENE_ASSET),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.changeScene(${ctx.input("scene")});`);
    },
  },
  {
    id: "scene.registerPostProcess",
    title: "Register Scene Post-Processing",
    description: "Adds a post-process Material after the current Scene's post-process passes and returns the new pass's Material Object.",
    category: "scene",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("material", "Material", "in", MATERIAL_ASSET),
      pin("pass", "Pass", "out", MATERIAL_OBJECT),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("pass")} = ctx.registerScenePostProcess(${ctx.input("material")});`);
    },
  },
  {
    id: "scene.unregisterPostProcess",
    title: "Unregister Scene Post-Processing",
    description: "Removes the first of the current Scene's post-process passes that uses a Material.",
    category: "scene",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("material", "Material", "in", MATERIAL_ASSET),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.unregisterScenePostProcess(${ctx.input("material")});`);
    },
  },
];
