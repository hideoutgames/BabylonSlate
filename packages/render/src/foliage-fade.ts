import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { Material } from "@babylonjs/core/Materials/material";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { registerPersistentMaterialPlugin } from "./material-plugin-registration";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

/**
 * The define that compiles the foliage fade, its `discard` included, into a surface's fragment shader. Set per mesh
 * (`meshCanFoliageFade`): every other draw keeps a fragment shader without the fade's `discard`, so the GPU keeps its
 * early depth test and tile-based hidden-surface removal for it.
 */
export const FOLIAGE_FADE_DEFINE = "HAPTIC_FOLIAGE_FADE";

/** A fading mesh's `[fadeStart, fadeEnd]`, owned by its metadata and rewritten in place. */
export type FoliageFadeRange = readonly [fadeStart: number, fadeEnd: number];

type FoliageFadeMetadata = { hapticFoliageFade?: unknown } | null | undefined;

/**
 * Whether `mesh` draws with the foliage fade compiled in: its metadata holds a `hapticFoliageFade` range, which a Play
 * foliage cell whose batch has a Cull Distance and a Fade Range keeps (`setFoliageFadeRange`).
 */
export function meshCanFoliageFade(mesh: AbstractMesh | null | undefined): boolean {
  return Array.isArray((mesh?.metadata as FoliageFadeMetadata)?.hapticFoliageFade);
}

/**
 * The dither fade range `[fadeStart, cullDistance]` a fading mesh is in this frame, or null when it is outside its fade
 * band or cannot fade. The range is the mesh's own, rewritten in place: read it, never keep it.
 */
export function foliageFadeForMesh(mesh: AbstractMesh | null | undefined): FoliageFadeRange | null {
  const value = (mesh?.metadata as FoliageFadeMetadata)?.hapticFoliageFade;
  if (!Array.isArray(value) || !(value[1] > 0)) return null;
  return value as unknown as FoliageFadeRange;
}

/**
 * Gives `mesh` a fade range to rewrite in place (`[0, 0]`: outside its band), or takes it away, and returns the range
 * (null without one). A change has every pass re-prepare the mesh's defines on its next draw (a frozen Material
 * otherwise answers from its draw wrappers' readiness) and marks the mesh's readiness.
 */
export function setFoliageFadeRange(mesh: AbstractMesh, fades: boolean): [number, number] | null {
  const metadata = (mesh.metadata ?? (mesh.metadata = {})) as { hapticFoliageFade?: [number, number] | null };
  const current = Array.isArray(metadata.hapticFoliageFade) ? metadata.hapticFoliageFade : null;
  if (!!current === fades) return current;
  const next: [number, number] | null = fades ? [0, 0] : null;
  metadata.hapticFoliageFade = next;
  for (const subMesh of mesh.subMeshes ?? []) {
    for (const wrapper of subMesh._drawWrappers) {
      if (!wrapper) continue;
      wrapper._wasPreviouslyReady = false;
      wrapper._wasPreviouslyUsingInstances = null;
      // Nor answer from this frame's readiness.
      if (wrapper.defines instanceof MaterialDefines) wrapper.defines._renderId = -1;
    }
  }
  markSceneReadinessDirty(mesh.getScene(), "foliageFade", [mesh]);
  return next;
}

const eyeScratch = new Vector3();

/**
 * The eye the fade measures from, in the space of the surface's `vPositionW`: the eye Babylon binds as `vEyePosition`
 * (the view's camera, or the position a mirror or probe forces), less the floating origin. With Large World Rendering
 * on, world positions are relative to the eye, so this is zero; off, it is the eye itself.
 */
export function foliageFadeEye(scene: Scene): Vector3 {
  const eye = scene.bindEyePosition(null);
  const origin = scene.floatingOriginOffset;
  return eyeScratch.copyFromFloats(eye.x - origin.x, eye.y - origin.y, eye.z - origin.z);
}

/**
 * Branchless 4x4 Bayer screen-door threshold in `(0, 1)` (works in all GLSL ES versions with no array indexing).
 * Every pixel in a 4x4 tile takes a unique value in `[0.5/16 .. 15.5/16]`.
 */
export const HAPTIC_BAYER_4X4_GLSL = `
float hapticBayer4x4(vec2 fragCoord) {
  float x0 = mod(floor(fragCoord.x), 2.0);
  float y0 = mod(floor(fragCoord.y), 2.0);
  float x1 = mod(floor(fragCoord.x * 0.5), 2.0);
  float y1 = mod(floor(fragCoord.y * 0.5), 2.0);
  float xor0 = abs(x0 - y0);
  float xor1 = abs(x1 - y1);
  return ((xor0 * 2.0 + y0) * 4.0 + (xor1 * 2.0 + y1) + 0.5) / 16.0;
}
`;

type FoliageFadeDefines = MaterialDefines & { [FOLIAGE_FADE_DEFINE]?: boolean };

/**
 * Opaque screen-door Bayer dither fade for foliage cells approaching their cull distance, on native PBR and Standard
 * Materials. The fade and its `discard` compile only under `HAPTIC_FOLIAGE_FADE`, which `prepareDefines` sets per mesh
 * (`meshCanFoliageFade`): a Material shared by foliage and other meshes compiles one variant for each, and every other
 * draw keeps a fragment shader without the discard, so early depth testing and tile-based hidden-surface removal stay
 * on for it. A fading mesh outside its band binds `(0, 0)` and skips the discard branch; a draw without the define
 * binds nothing.
 */
export class FoliageFadePlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "HapticFoliageFade", 215, { [FOLIAGE_FADE_DEFINE]: false }, true, false);
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  override isCompatible(): boolean {
    return true;
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const fades = meshCanFoliageFade(mesh);
    const values = defines as FoliageFadeDefines;
    if (values[FOLIAGE_FADE_DEFINE] === fades) return;
    // Babylon recompiles only on its own dirty flags: a mesh that gained or lost its fade asks for the other variant.
    values[FOLIAGE_FADE_DEFINE] = fades;
    defines.markAsUnprocessed();
  }

  override getUniforms() {
    return {
      ubo: [
        { name: "hapticFoliageFade", size: 2, type: "vec2" },
        { name: "hapticFoliageCamera", size: 3, type: "vec3" },
      ],
    };
  }

  override hardBindForSubMesh(
    uniformBuffer: UniformBuffer,
    scene: Scene,
    _engine: unknown,
    subMesh: SubMesh,
  ): void {
    // Only a variant compiled with the fade reads these uniforms.
    if (!(subMesh.materialDefines as FoliageFadeDefines | null)?.[FOLIAGE_FADE_DEFINE]) return;
    const fade = foliageFadeForMesh(subMesh.getMesh());
    if (!fade) {
      uniformBuffer.updateFloat2("hapticFoliageFade", 0, 0);
      return;
    }
    uniformBuffer.updateFloat2("hapticFoliageFade", fade[0], fade[1]);
    const eye = foliageFadeEye(scene);
    uniformBuffer.updateFloat3("hapticFoliageCamera", eye.x, eye.y, eye.z);
  }

  override getCustomCode(type: string) {
    if (type !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef ${FOLIAGE_FADE_DEFINE}\n${HAPTIC_BAYER_4X4_GLSL}#endif\n`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
#ifdef ${FOLIAGE_FADE_DEFINE}
if (hapticFoliageFade.y > 0.0) {
  float hapticFoliageDist = distance(vPositionW, hapticFoliageCamera);
  float hapticFoliageT = clamp((hapticFoliageDist - hapticFoliageFade.x) / max(0.001, hapticFoliageFade.y - hapticFoliageFade.x), 0.0, 1.0);
  if (hapticFoliageT > 0.0 && hapticFoliageT >= hapticBayer4x4(gl_FragCoord.xy)) {
    discard;
  }
}
#endif
`,
    };
  }
}

registerPersistentMaterialPlugin("HapticFoliageFade", (material) =>
  material instanceof PBRBaseMaterial || material instanceof StandardMaterial
    ? new FoliageFadePlugin(material)
    : null,
);
