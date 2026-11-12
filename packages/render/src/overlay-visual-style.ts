import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { parseOverlayVisualStyle, type OverlayVisualStyle } from "@haptic/core";
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

/**
 * `target` draws with `source`'s style (its opacity and tint, live), or white without one: a draw batch binds what its
 * members bind (`draw-batching.ts`).
 */
export function shareOverlayVisualStyle(target: AbstractMesh, source: AbstractMesh): void {
  const binding = bindings.get(source);
  if (binding) bindings.set(target, binding);
  else bindings.delete(target);
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
  const style = parseOverlayVisualStyle(value);
  const held = binding.style;
  // Asked on every tick of a fade and every redraw of a control: the same values keep the style object they have.
  if (style.opacity === held.opacity && style.tint[0] === held.tint[0] && style.tint[1] === held.tint[1] && style.tint[2] === held.tint[2] &&
    style.tint[3] === held.tint[3]) return;
  binding.style = style;
  if ((before < 1) !== (binding.style.opacity * binding.style.tint[3] < 1)) markSceneReadinessDirty(root.getScene(), "layerStyle");
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
  override getUniforms() {
    return {
      ubo: [{ name: "slateOverlayTint", size: 4, type: "vec4" }],
      fragment: this._material.getScene().getEngine().supportsUniformBuffers ? undefined : "uniform vec4 slateOverlayTint;",
    };
  }
  override getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== "fragment") return null;
    const tint = `${language === 1 ? "uniforms." : ""}slateOverlayTint`;
    const premultiply = language === 1 ? `color = vec4f(color.rgb * ${tint}.a, color.a);` : `color.rgb *= ${tint}.a;`;
    return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `\n#ifdef SLATE_OVERLAY_STYLE\ncolor *= ${tint};\n#ifdef PREMULTIPLYALPHA\n${premultiply}\n#endif\n#endif\n` };
  }
}
