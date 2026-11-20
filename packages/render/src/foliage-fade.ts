import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { Material } from "@babylonjs/core/Materials/material";
import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Scene } from "@babylonjs/core/scene";
import { registerPersistentMaterialPlugin } from "./material-plugin-registration";

export type FoliageFadeRange = readonly [fadeStart: number, fadeEnd: number];

/** Read the per-cell dither fade range `[fadeStart, cullDistance]` attached by `FoliageDistanceController`, or null. */
export function foliageFadeForMesh(mesh: AbstractMesh | null | undefined): FoliageFadeRange | null {
  const value = (mesh?.metadata as { slateFoliageFade?: unknown } | null | undefined)?.slateFoliageFade;
  if (!Array.isArray(value) || value.length < 2) return null;
  const start = Number(value[0]);
  const end = Number(value[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= 0) return null;
  return [start, end];
}

/**
 * Branchless 4x4 Bayer screen-door threshold in `(0, 1)` (works in all GLSL ES versions with no array indexing).
 * Every pixel in a 4x4 tile takes a unique value in `[0.5/16 .. 15.5/16]`.
 */
export const SLATE_BAYER_4X4_GLSL = `
float slateBayer4x4(vec2 fragCoord) {
  float x0 = mod(floor(fragCoord.x), 2.0);
  float y0 = mod(floor(fragCoord.y), 2.0);
  float x1 = mod(floor(fragCoord.x * 0.5), 2.0);
  float y1 = mod(floor(fragCoord.y * 0.5), 2.0);
  float xor0 = abs(x0 - y0);
  float xor1 = abs(x1 - y1);
  return ((xor0 * 2.0 + y0) * 4.0 + (xor1 * 2.0 + y1) + 0.5) / 16.0;
}
`;

/**
 * Opaque screen-door Bayer dither fade for foliage cells approaching their cull distance.
 * Registered persistently on native PBR/Standard materials with zero extra shader defines;
 * non-fading meshes bind `(0, 0)` and skip the discard branch completely.
 */
export class FoliageFadePlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "SlateFoliageFade", 215, {}, true, false);
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  override isCompatible(): boolean {
    return true;
  }

  override getUniforms() {
    return {
      ubo: [
        { name: "slateFoliageFade", size: 2, type: "vec2" },
        { name: "slateFoliageCamera", size: 3, type: "vec3" },
      ],
    };
  }

  override hardBindForSubMesh(
    uniformBuffer: UniformBuffer,
    scene: Scene,
    _engine: unknown,
    subMesh: SubMesh,
  ): void {
    const fade = foliageFadeForMesh(subMesh.getMesh());
    if (!fade) {
      uniformBuffer.updateFloat2("slateFoliageFade", 0, 0);
      return;
    }
    uniformBuffer.updateFloat2("slateFoliageFade", fade[0], fade[1]);
    const cam = scene.activeCamera?.globalPosition;
    uniformBuffer.updateFloat3("slateFoliageCamera", cam?.x ?? 0, cam?.y ?? 0, cam?.z ?? 0);
  }

  override getCustomCode(type: string) {
    if (type !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: SLATE_BAYER_4X4_GLSL,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
if (slateFoliageFade.y > 0.0) {
  float slateFoliageDist = distance(vPositionW, slateFoliageCamera);
  float slateFoliageT = clamp((slateFoliageDist - slateFoliageFade.x) / max(0.001, slateFoliageFade.y - slateFoliageFade.x), 0.0, 1.0);
  if (slateFoliageT > 0.0 && slateFoliageT >= slateBayer4x4(gl_FragCoord.xy)) {
    discard;
  }
}
`,
    };
  }
}

registerPersistentMaterialPlugin("SlateFoliageFade", (material) =>
  material instanceof PBRBaseMaterial || material instanceof StandardMaterial
    ? new FoliageFadePlugin(material)
    : null,
);
