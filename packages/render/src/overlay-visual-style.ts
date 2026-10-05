import {
  MaterialPluginBase, StandardMaterial,
  type AbstractMesh, type MaterialDefines, type Scene, type ShaderLanguage, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import { parseOverlayVisualStyle, type OverlayVisualStyle } from "@babylonslate/core";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

type VisualStyleBinding = { style: OverlayVisualStyle; meshes: AbstractMesh[] };
const bindings = new WeakMap<AbstractMesh, VisualStyleBinding>();
const roots = new WeakMap<AbstractMesh, VisualStyleBinding>();
const materials = new WeakSet<StandardMaterial>();
const white: OverlayVisualStyle = { opacity: 1, tint: [1, 1, 1, 1] };

/** Constant-time binding lookup; glyph reveal remains a separate visibility multiplier. */
export function overlayVisualStyle(mesh: AbstractMesh | undefined): OverlayVisualStyle {
  return mesh ? bindings.get(mesh)?.style ?? white : white;
}

/** Bind only this component's native children, before other components are parented beneath it. */
export function applyOverlayVisualStyle(root: AbstractMesh, value: unknown): void {
  let binding = roots.get(root);
  if (!binding) {
    binding = { style: white, meshes: [root, ...root.getChildMeshes()] };
    roots.set(root, binding);
    for (const mesh of binding.meshes) {
      bindings.set(mesh, binding);
      enableOverlayVisualMaterial(mesh);
    }
    root.onDisposeObservable.addOnce(() => {
      roots.delete(root);
      for (const mesh of binding!.meshes) bindings.delete(mesh);
    });
  }
  const before = binding.style.opacity * binding.style.tint[3];
  binding.style = parseOverlayVisualStyle(value);
  if ((before < 1) !== (binding.style.opacity * binding.style.tint[3] < 1)) markSceneReadinessDirty(root.getScene());
}

/** Also called when a texture finishes replacing its owned construction material. */
export function enableOverlayVisualMaterial(mesh: AbstractMesh): void {
  const material = mesh.material;
  if (!bindings.has(mesh) || !(material instanceof StandardMaterial) || materials.has(material)) return;
  materials.add(material);
  new OverlayVisualStylePlugin(material);
}

/** Shared Standard materials bind component multipliers per draw, without editing their color or alpha. */
class OverlayVisualStylePlugin extends MaterialPluginBase {
  constructor(material: StandardMaterial) {
    super(material, "SlateOverlayVisualStyle", 220, { SLATE_OVERLAY_STYLE: false }, true, false);
    this.registerForExtraEvents = true;
    this._enable(true);
    const needAlphaBlending = material.needAlphaBlendingForMesh.bind(material);
    material.needAlphaBlendingForMesh = (mesh) => {
      const style = overlayVisualStyle(mesh);
      return style.opacity * style.tint[3] < 1 || needAlphaBlending(mesh);
    };
  }
  override isCompatible(): boolean { return true; }
  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    defines.SLATE_OVERLAY_STYLE = bindings.has(mesh);
  }
  override hardBindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    const { opacity, tint } = overlayVisualStyle(subMesh.getMesh());
    buffer.updateFloat4("slateOverlayTint", tint[0], tint[1], tint[2], tint[3] * opacity);
  }
  override getUniforms() { return { ubo: [{ name: "slateOverlayTint", size: 4, type: "vec4" }] }; }
  override getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== "fragment") return null;
    return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `\n#ifdef SLATE_OVERLAY_STYLE\ncolor *= ${language === 1 ? "uniforms." : ""}slateOverlayTint;\n#endif\n` };
  }
}
