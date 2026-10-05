import type { AbstractMesh, Scene, SubMesh } from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { SmartArray } from "@babylonjs/core/Misc/smartArray";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import type { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import { isMeshFrameReady } from "./scene-perf";

type SortCompare = (a: SubMesh, b: SubMesh) => number;
/** The Babylon 9.20 members `RenderingGroup._RenderSorted` reads; the sort is the group's (authored or default). */
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
 * (`setMaterialForRenderPass`) are not mirrored into the pre-pass; the passes that use this set none.
 */
export class TransparentDepthPrePass {
  /** Render pass id of the pre-pass draws (the colour draws keep their pass's own). */
  readonly renderPassId: number;
  private readonly scene: Scene;
  /** Per frame: the transparent submeshes in draw order, cleared after drawing. */
  private readonly sorted: (SubMesh | null)[] = [];
  private disposed = false;

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

  private drawSorted(data: readonly SubMesh[], count: number, group: RenderingGroup | undefined): void {
    if (count === 0) return;
    const scene = this.scene, engine = scene.getEngine();
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
    // A disposed owner (a retained graph's last frames) draws as Babylon does, without a pre-pass of its own id.
    const prePass = !sortedGroup?.disableDepthPrePass, ownPass = !this.disposed;
    try {
      for (let index = 0; index < count; index += 1) {
        const subMesh = sorted[index]!;
        if (scene._activeMeshesFrozenButKeepClipping && !subMesh.isInFrustum(scene._frustumPlanes)) continue;
        if (prePass && subMesh.getMaterial()?.needDepthPrePass) {
          const pass = engine.currentRenderPassId;
          engine.setColorWrite(false);
          engine.setAlphaMode(Constants.ALPHA_DISABLE);
          if (ownPass) engine.currentRenderPassId = this.renderPassId;
          try {
            subMesh.render(false);
          } finally {
            engine.currentRenderPassId = pass;
            engine.setColorWrite(true);
          }
        }
        subMesh.render(true);
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

/**
 * The same for a scene's own camera passes (classic frames): `Scene.render` passes its rendering manager no
 * transparent hook, so the manager's `render` is wrapped while attached. Returns the detach function.
 */
export function attachSceneDepthPrePass(scene: Scene): () => void {
  const manager = (scene as unknown as { _renderingManager: RenderingManager })._renderingManager;
  const prePass = new TransparentDepthPrePass(scene, "Scene");
  const render = manager.render;
  const wrapped: RenderingManager["render"] = function (this: RenderingManager, custom, meshes, particles, sprites, depthOnly, opaque, alphaTest, transparent, hook) {
    render.call(this, custom, meshes, particles, sprites, depthOnly, opaque, alphaTest, transparent, hook ?? prePass.renderTransparent);
  };
  manager.render = wrapped;
  return () => {
    if (manager.render === wrapped) manager.render = render;
    prePass.dispose();
  };
}
