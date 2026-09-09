import {
  Material,
  Mesh,
  NodeMaterial,
  PBRMetallicRoughnessBlock,
  type Scene,
} from "@babylonjs/core";
import { isColliderVisualMesh } from "./collider-visual";
import { isEditorBillboardMesh } from "./editor-billboard";
import { CAMERA_BOUNDS_MESH_NAME, GRID_MESH_NAME } from "./editor-grid";
import { isEditorVolumeMesh } from "./editor-volume";
import { isEditorModelPlaceholder } from "./glb-anim";
import { isEditorActorOrigin } from "./scene-loader";

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

const SKIP_NAME_PREFIXES = [
  "debugFrustum:",
  "debugLight:",
  "debugPreviewCam:",
  "debugCameraPreview:",
  "navmeshDebug",
] as const;

export function isViewportShadingTarget(mesh: Mesh): boolean {
  if (isEditorBillboardMesh(mesh)) return false;
  if (isEditorVolumeMesh(mesh)) return false;
  if (isColliderVisualMesh(mesh)) return false;
  if (isEditorActorOrigin(mesh)) return false;
  if (isEditorModelPlaceholder(mesh)) return false;
  if (mesh.name === GRID_MESH_NAME) return false;
  if (mesh.name === CAMERA_BOUNDS_MESH_NAME) return false;
  return !SKIP_NAME_PREFIXES.some((prefix) => mesh.name.startsWith(prefix));
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
    } finally {
      this.scene.blockMaterialDirtyMechanism = blocked;
    }
  }
}
