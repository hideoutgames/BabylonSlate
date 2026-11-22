import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { parseOverlayVisualStyle, type OverlayVisualStyle } from "@haptic/core";
import { noteRenderChange, RenderChange } from "./render-change-journal";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

type VisualStyleBinding = {
  style: OverlayVisualStyle;
  meshes: AbstractMesh[];
  /** Meshes of a component binding that also carry a letter tint; null on a letter tint's own binding. */
  tinted: LetterTint[] | null;
};
/**
 * One mesh's RGB multiplier over its component's style (a Rich Text letter's Tint). While it is not white the mesh
 * draws through `binding`, its own, whose style is the component's times this tint, worked out only when either
 * changes; at white the mesh draws through the component's binding again, so an untinted mesh's draw reads exactly
 * what it did without one.
 */
type LetterTint = {
  mesh: AbstractMesh;
  r: number; g: number; b: number;
  /** The component binding whose style this composes with; null until the component's style is first applied. */
  source: VisualStyleBinding | null;
  binding: VisualStyleBinding;
};
const bindings = new WeakMap<AbstractMesh, VisualStyleBinding>();
const roots = new WeakMap<AbstractMesh, VisualStyleBinding>();
const letterTints = new WeakMap<AbstractMesh, LetterTint>();
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
    binding = { style: white, meshes: [root, ...root.getChildMeshes()], tinted: null };
    roots.set(root, binding);
    for (const mesh of binding.meshes) {
      bindings.set(mesh, binding);
      // A letter tint set before its component's style composes with it from now on.
      const tint = letterTints.get(mesh);
      if (tint) attachLetterTint(tint, binding);
      enableOverlayVisualMaterial(mesh);
      noteRenderChange(mesh);
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
  if (binding.tinted) for (const tint of binding.tinted) composeLetterTint(tint);
  // Each of its meshes draws the new style: the render change journal hears of each, as a style change.
  for (const mesh of binding.meshes) noteRenderChange(mesh, RenderChange.Style);
  // Only this component's own meshes blend differently now.
  if ((before < 1) !== (binding.style.opacity * binding.style.tint[3] < 1)) markSceneReadinessDirty(root.getScene(), "layerStyle", binding.meshes);
}

/**
 * Multiplies `mesh`'s colour by `r`, `g` and `b` on top of its component's style (a Rich Text letter's Tint); white
 * (1, 1, 1) removes it. Call it only when the value changes; it composes with styles applied before or after.
 */
export function setOverlayLetterTint(mesh: AbstractMesh, r: number, g: number, b: number): void {
  let tint = letterTints.get(mesh);
  if (!tint) {
    if (r === 1 && g === 1 && b === 1) return;
    const own: LetterTint = { mesh, r: 1, g: 1, b: 1, source: null, binding: { style: white, meshes: [mesh], tinted: null } };
    tint = own;
    letterTints.set(mesh, own);
    const source = bindings.get(mesh);
    if (source) attachLetterTint(own, source);
    mesh.onDisposeObservable.addOnce(() => {
      letterTints.delete(mesh);
      const list = own.source?.tinted;
      const at = list ? list.indexOf(own) : -1;
      if (at >= 0) list!.splice(at, 1);
      if (bindings.get(mesh) === own.binding) bindings.delete(mesh);
    });
  }
  if (tint.r === r && tint.g === g && tint.b === b) return;
  tint.r = r;
  tint.g = g;
  tint.b = b;
  composeLetterTint(tint);
  noteRenderChange(mesh, RenderChange.Style);
}

function attachLetterTint(tint: LetterTint, source: VisualStyleBinding): void {
  tint.source = source;
  (source.tinted ??= []).push(tint);
  composeLetterTint(tint);
}

/**
 * The letter's own binding takes its component's style times its tint, and the mesh draws through it, or through the
 * component's binding at white. The own binding stays current even then: a draw batch may still share it.
 */
function composeLetterTint(tint: LetterTint): void {
  const base = tint.source?.style ?? white;
  const isWhite = tint.r === 1 && tint.g === 1 && tint.b === 1;
  tint.binding.style = isWhite ? base : {
    opacity: base.opacity,
    tint: [base.tint[0] * tint.r, base.tint[1] * tint.g, base.tint[2] * tint.b, base.tint[3]],
  };
  const drawn = isWhite ? tint.source : tint.binding;
  if (drawn) bindings.set(tint.mesh, drawn);
  else bindings.delete(tint.mesh);
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
    super(material, "HapticOverlayVisualStyle", 220, { HAPTIC_OVERLAY_STYLE: false }, true, false);
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
    defines.HAPTIC_OVERLAY_STYLE = bindings.has(mesh);
  }
  override hardBindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    const { opacity, tint } = overlayVisualStyle(subMesh.getMesh());
    buffer.updateFloat4("hapticOverlayTint", tint[0], tint[1], tint[2], tint[3] * opacity);
  }
  override getUniforms() {
    return {
      ubo: [{ name: "hapticOverlayTint", size: 4, type: "vec4" }],
      fragment: this._material.getScene().getEngine().supportsUniformBuffers ? undefined : "uniform vec4 hapticOverlayTint;",
    };
  }
  override getCustomCode(type: string) {
    if (type !== "fragment") return null;
    return { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "\n#ifdef HAPTIC_OVERLAY_STYLE\ncolor *= hapticOverlayTint;\n#ifdef PREMULTIPLYALPHA\ncolor.rgb *= hapticOverlayTint.a;\n#endif\n#endif\n" };
  }
}
