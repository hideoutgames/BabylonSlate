import {
  Material,
  Mesh,
  NodeMaterial,
  PBRMetallicRoughnessBlock,
  type Scene,
} from "@babylonjs/core";
import { isEditorHelperMesh } from "./helper-mesh";
import { isSkyboxMesh } from "./skybox";

export type ViewportShadingMode = "pbr" | "unlit" | "wireframe";

type LightingMaterial = Material & {
  unlit?: boolean;
  disableLighting?: boolean;
};

type ShadingRestore = {
  wireframe: boolean;
  pointsCloud: boolean;
  unlit?: boolean;
  disableLighting?: boolean;
  pbrBlocks: { block: PBRMetallicRoughnessBlock; unlit: boolean }[];
};

/** Viewport modes restyle authored world meshes only, never editor or debug helpers. */
export function isViewportShadingTarget(mesh: Mesh): boolean {
  return !isEditorHelperMesh(mesh);
}

function lightingMaterial(material: Material): LightingMaterial {
  return material as LightingMaterial;
}

/**
 * Session overlay for editor Viewport Mode (PBR / Unlit / Wireframe).
 * Mutates live materials and restores authored flags; does not write scene
 * documents.
 */
export class ViewportShadingOverlay {
  private current: ViewportShadingMode = "pbr";
  private readonly originals = new WeakMap<Material, ShadingRestore>();
  private lightsEnabledRestore = true;
  private capturedLights = false;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get mode(): ViewportShadingMode {
    return this.current;
  }

  setMode(mode: ViewportShadingMode): void {
    this.current = mode;
    this.apply();
  }

  apply(): void {
    if (!this.capturedLights) {
      this.lightsEnabledRestore = this.scene.lightsEnabled;
      this.capturedLights = true;
    }
    this.scene.lightsEnabled =
      this.current === "unlit" ? false : this.lightsEnabledRestore;

    const applied = new Set<Material>();
    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh) || !isViewportShadingTarget(mesh)) continue;
      // Skyboxes display their cubemap through PBR reflections, which Unlit
      // removes. Keep the background intact in every surface shading mode.
      if (isSkyboxMesh(mesh)) continue;
      const material = mesh.material ?? this.scene.defaultMaterial;
      if (!material || applied.has(material)) continue;
      applied.add(material);
      this.snapshot(material);
      this.applyFlags(material);
    }
  }

  private snapshot(material: Material): void {
    if (this.originals.has(material)) return;
    const lit = lightingMaterial(material);
    this.originals.set(material, {
      wireframe: material.wireframe,
      pointsCloud: material.pointsCloud,
      unlit: "unlit" in lit ? Boolean(lit.unlit) : undefined,
      disableLighting:
        "disableLighting" in lit ? Boolean(lit.disableLighting) : undefined,
      pbrBlocks:
        material instanceof NodeMaterial
          ? material.attachedBlocks
              .filter(
                (block): block is PBRMetallicRoughnessBlock =>
                  block instanceof PBRMetallicRoughnessBlock,
              )
              .map((block) => ({ block, unlit: block.unlit }))
          : [],
    });
  }

  private applyFlags(material: Material): void {
    const original = this.originals.get(material);
    if (!original) return;
    const lit = lightingMaterial(material);
    const previousFill = material.fillMode;
    const previousUnlit = lit.unlit;
    const previousDisableLighting = lit.disableLighting;
    if (this.current === "wireframe") {
      material.fillMode = Material.WireFrameFillMode;
    } else if (original.wireframe) {
      material.fillMode = Material.WireFrameFillMode;
    } else if (original.pointsCloud) {
      material.fillMode = Material.PointFillMode;
    } else {
      material.fillMode = Material.TriangleFillMode;
    }
    if (original.unlit !== undefined) {
      lit.unlit = this.current === "unlit" ? true : original.unlit;
    }
    if (original.disableLighting !== undefined) {
      lit.disableLighting =
        this.current === "unlit" ? true : original.disableLighting;
    }
    let changed =
      material.fillMode !== previousFill ||
      lit.unlit !== previousUnlit ||
      lit.disableLighting !== previousDisableLighting;
    for (const { block, unlit } of original.pbrBlocks) {
      const next = this.current === "unlit" ? true : unlit;
      if (block.unlit === next) continue;
      block.unlit = next;
      changed = true;
    }
    if (!changed) return;
    // Block properties have no invalidating setter. Frozen materials also
    // cache readiness, so refresh both defines and readiness without unfreezing.
    const blocked = this.scene.blockMaterialDirtyMechanism;
    this.scene.blockMaterialDirtyMechanism = false;
    try {
      material.markDirty(true);
      if (material instanceof NodeMaterial && material.isFrozen) {
        // A frozen NodeMaterial can mark the old hot-swapped effect ready
        // while its replacement is compiling, then never revisit the switch.
        // Drop that fallback so readiness follows the requested shader.
        material.resetDrawCache();
      }
    } finally {
      this.scene.blockMaterialDirtyMechanism = blocked;
    }
  }
}
