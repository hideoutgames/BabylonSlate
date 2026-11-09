import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { SmartArray } from "@babylonjs/core/Misc/smartArray";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import { sceneDrawBatcher } from "./draw-batching";
import { isMeshFrameReady } from "./scene-perf";
import { waterDebugOff } from "./water-debug";
import { isWaterSurfaceMesh } from "./water-mesh-surface";

type SortCompare = (a: SubMesh, b: SubMesh) => number;
/** The Babylon 9.29 members `RenderingGroup._RenderSorted` reads; the sort is the group's (authored or default). */
type SortedGroup = { _transparentSortCompareFn?: SortCompare | null; disableDepthPrePass?: boolean };
type TransparentHook = (subMeshes: SmartArray<SubMesh>, group?: RenderingGroup) => void;

/** Whether one of `mesh`'s blended draws carries a depth pre-pass (`needDepthPrePass`). */
function drawsDepthPrePass(mesh: AbstractMesh): boolean {
  const parts = mesh.subMeshes;
  if (!parts) return false;
  for (let index = 0; index < parts.length; index += 1) {
    const material = parts[index]!.getMaterial();
    if (material?.needDepthPrePass && material.needAlphaBlendingForMesh(mesh)) return true;
  }
  return false;
}

/**
 * Transparent depth pre-passes drawn under their own render pass id.
 *
 * Babylon draws a `needDepthPrePass` material's pre-pass through the colour draw's per-pass draw wrapper and picks the
 * variant from the colour-write state (`DEPTHPREPASS`, a frame-bound define). Unfrozen materials therefore
 * re-prepare their effect (and rebind every uniform) for both draws of every frame. Frozen ones (Play's Intermediate
 * priority) re-prepare neither, so both draws bind whichever variant was prepared last: the full shader paid twice
 * per pixel, or the depth-only variant drawing opaque black in the colour pass after the material is marked dirty.
 *
 * `renderTransparent` replaces a rendering manager's sorted transparent rendering with the same order, frozen-list
 * clipping and state changes as Babylon's (`RenderingGroup._RenderSorted`), allocation-free, and draws each pre-pass
 * under `renderPassId`, so each variant keeps its own stable draw wrapper. Per-pass material overrides
 * (`setMaterialForRenderPass`) are not mirrored into the pre-pass; the passes that use this set none. A Scene that
 * batches its draws (`sceneDrawBatcher`, Scene Layers) hands the sorted list to its batcher.
 */
export class TransparentDepthPrePass {
  /** Render pass id of the pre-pass draws (the colour draws keep their pass's own). */
  readonly renderPassId: number;
  private readonly scene: Scene;
  /** Per frame: the transparent submeshes in draw order, cleared after drawing. */
  private readonly sorted: (SubMesh | null)[] = [];
  private disposed = false;
  /** Whether the group drawing now draws pre-passes (its `disableDepthPrePass` is off). */
  private prePass = true;
  /** Whether water draws its pre-pass now (`waterdebug prepass off` measures it without). */
  private waterPrePass = true;

  constructor(scene: Scene, name: string) {
    this.scene = scene;
    this.renderPassId = scene.getEngine().createRenderPassId(`${name} depth pre-pass`);
  }

  /** A rendering manager's `customRenderTransparentSubMeshes`. */
  readonly renderTransparent: TransparentHook = (subMeshes, group) => {
    const scene = this.scene;
    if (scene.useOrderIndependentTransparency && scene.depthPeelingRenderer) {
      // As Babylon does: depth peeling draws what it can and the rest is sorted.
      const excluded = scene.depthPeelingRenderer.render(subMeshes);
      this.drawSorted(excluded.data, excluded.length, group);
      return;
    }
    this.drawSorted(subMeshes.data, subMeshes.length, group);
  };

  /**
   * Strict readiness of `mesh`'s pre-pass variants, probed as `isMeshFrameReady` probes its colour variants (call it
   * alongside), so the first presented frame already draws the pre-pass. True when the mesh draws none.
   */
  isReady(mesh: AbstractMesh): boolean {
    if (this.disposed || !drawsDepthPrePass(mesh)) return true;
    const engine = this.scene.getEngine();
    const pass = engine.currentRenderPassId, colorWrite = engine.getColorWrite();
    engine.currentRenderPassId = this.renderPassId;
    engine.setColorWrite(false);
    try {
      return isMeshFrameReady(mesh);
    } finally {
      engine.setColorWrite(colorWrite);
      engine.currentRenderPassId = pass;
    }
  }

  /** Releases the render pass id, which also drops every submesh's draw wrapper for it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.getEngine().releaseRenderPassId(this.renderPassId);
  }

  /** Draws one blended submesh: its depth pre-pass first when its Material has one, then its colour. */
  private readonly drawOne = (subMesh: SubMesh): void => {
    if (this.prePass && subMesh.getMaterial()?.needDepthPrePass && (this.waterPrePass || !isWaterSurfaceMesh(subMesh.getMesh()))) {
      const engine = this.scene.getEngine(), pass = engine.currentRenderPassId;
      engine.setColorWrite(false);
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      // Once disposed (its id released), pre-passes draw under the colour pass's id, as Babylon does.
      if (!this.disposed) engine.currentRenderPassId = this.renderPassId;
      try {
        subMesh.render(false);
      } finally {
        engine.currentRenderPassId = pass;
        engine.setColorWrite(true);
      }
    }
    subMesh.render(true);
  };

  private drawSorted(data: readonly SubMesh[], count: number, group: RenderingGroup | undefined): void {
    if (count === 0) return;
    const scene = this.scene;
    const camera = scene.activeCamera, eye = camera ? camera.globalPosition : Vector3.ZeroReadOnly;
    const sorted = this.sorted;
    sorted.length = count;
    for (let index = 0; index < count; index += 1) {
      const subMesh = data[index]!;
      subMesh._alphaIndex = subMesh.getMesh().alphaIndex;
      subMesh._distanceToCamera = Vector3.Distance(subMesh.getBoundingInfo().boundingSphere.centerWorld, eye);
      sorted[index] = subMesh;
    }
    const sortedGroup = group as SortedGroup | undefined;
    (sorted as SubMesh[]).sort(sortedGroup?._transparentSortCompareFn ?? RenderingGroup.defaultTransparentSortCompare);
    this.prePass = !sortedGroup?.disableDepthPrePass;
    this.waterPrePass = !waterDebugOff(scene, "prepass");
    try {
      const batcher = scene._activeMeshesFrozenButKeepClipping ? undefined : sceneDrawBatcher(scene);
      if (batcher) {
        batcher.draw(sorted as SubMesh[], count, true, this.drawOne);
        return;
      }
      for (let index = 0; index < count; index += 1) {
        const subMesh = sorted[index]!;
        if (scene._activeMeshesFrozenButKeepClipping && !subMesh.isInFrustum(scene._frustumPlanes)) continue;
        this.drawOne(subMesh);
      }
    } finally {
      // Hold no submesh between frames.
      for (let index = 0; index < count; index += 1) sorted[index] = null;
    }
  }
}

/** Gives an object renderer's transparent depth pre-passes their own render pass id; dispose the result with it. */
export function attachObjectRendererDepthPrePass(scene: Scene, renderer: ObjectRenderer): TransparentDepthPrePass {
  const prePass = new TransparentDepthPrePass(scene, renderer.name);
  renderer.customRenderTransparentSubMeshes = prePass.renderTransparent;
  return prePass;
}
