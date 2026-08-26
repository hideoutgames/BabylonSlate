import {
  Camera,
  Color3,
  Color4,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type Engine,
} from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  parseSceneLayerHitTest,
  walkOverlayPointerHits,
  type OverlayPointerHit,
  type SceneLayerHitTest,
} from "@babylonslate/core";
import { installEngineDefaultMaterial } from "./default-material";

export type SceneLayerCreateCommand = Extract<
  CommandMessage,
  { type: "sceneLayerCreate" }
>;

export type SceneLayerPostProcessEntry = {
  materialGuid: string;
  enabled: boolean;
};

export interface SceneLayerView {
  layerId: string;
  assetGuid: string;
  zOrder: number;
  scene: Scene;
  camera: UniversalCamera;
}

export interface SceneLayerCompositorOptions {
  engine: Engine;
  worldScene: Scene;
  postProcessingEnabled?: () => boolean;
  attachLayerPostProcess?: (layer: SceneLayerView, stack: SceneLayerPostProcessEntry[]) => void;
  orthoHalfHeight?: number;
}

type LayerRecord = SceneLayerView & {
  postProcessStack: SceneLayerPostProcessEntry[];
  rtt: RenderTargetTexture | null;
  blitMaterial: StandardMaterial | null;
  blitScene: Scene | null;
};

const DEFAULT_ORTHO_HALF_HEIGHT = 4.5;

/**
 * Play-only overlay stack: extra unlit orthographic Scenes on the shared
 * Engine, drawn after the world camera (and its post-process).
 */
export class SceneLayerCompositor {
  private readonly engine: Engine;
  private readonly worldScene: Scene;
  private readonly postProcessingEnabled: () => boolean;
  private readonly attachLayerPostProcess?: SceneLayerCompositorOptions["attachLayerPostProcess"];
  private readonly orthoHalfHeight: number;
  private readonly byId = new Map<string, LayerRecord>();
  private readonly slotLayer = new Map<number, string>();
  private readonly slotActor = new Map<number, string>();

  constructor(options: SceneLayerCompositorOptions) {
    this.engine = options.engine;
    this.worldScene = options.worldScene;
    this.postProcessingEnabled = options.postProcessingEnabled ?? (() => true);
    this.attachLayerPostProcess = options.attachLayerPostProcess;
    this.orthoHalfHeight = options.orthoHalfHeight ?? DEFAULT_ORTHO_HALF_HEIGHT;
  }

  create(command: SceneLayerCreateCommand): SceneLayerView {
    this.remove(command.layerId);
    const scene = new Scene(this.engine);
    installEngineDefaultMaterial(scene);
    scene.lightsEnabled = false;
    scene.skipPointerMovePicking = false;
    scene.autoClear = false;
    scene.autoClearDepthAndStencil = true;
    scene.clearColor = new Color4(0, 0, 0, 0);
    const camera = new UniversalCamera(
      "sceneLayerCamera",
      new Vector3(0, 0, -10),
      scene,
    );
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    scene.activeCamera = camera;
    const layer: LayerRecord = {
      layerId: command.layerId,
      assetGuid: command.assetGuid,
      zOrder: command.zOrder,
      scene,
      camera,
      postProcessStack: command.postProcessStack.map((entry) => ({ ...entry })),
      rtt: null,
      blitMaterial: null,
      blitScene: null,
    };
    this.applyOrtho(layer);
    this.byId.set(command.layerId, layer);
    this.rebuildPostProcess(layer);
    return layer;
  }

  remove(layerId: string): void {
    const layer = this.byId.get(layerId);
    if (!layer) return;
    for (const [slotId, id] of [...this.slotLayer]) {
      if (id === layerId) this.slotLayer.delete(slotId);
    }
    this.releasePostProcess(layer);
    layer.scene.dispose();
    this.byId.delete(layerId);
  }

  clear(): void {
    for (const layerId of [...this.byId.keys()]) {
      this.remove(layerId);
    }
  }

  setPostProcess(
    layerId: string,
    stack: readonly SceneLayerPostProcessEntry[],
  ): void {
    const layer = this.byId.get(layerId);
    if (!layer) return;
    layer.postProcessStack = stack.map((entry) => ({ ...entry }));
    this.rebuildPostProcess(layer);
  }

  refreshPostProcess(): void {
    for (const layer of this.byId.values()) {
      this.rebuildPostProcess(layer);
    }
  }

  noteSpawn(
    slotId: number,
    sceneLayerId: string | null | undefined,
    actorGuid?: string | null,
  ): void {
    if (!sceneLayerId) {
      this.slotLayer.delete(slotId);
      this.slotActor.delete(slotId);
      return;
    }
    this.slotLayer.set(slotId, sceneLayerId);
    if (actorGuid) this.slotActor.set(slotId, actorGuid);
  }

  noteDespawn(slotId: number): void {
    this.slotLayer.delete(slotId);
    this.slotActor.delete(slotId);
  }

  sceneForSlot(slotId: number): Scene | null {
    const layerId = this.slotLayer.get(slotId);
    if (!layerId) return null;
    return this.byId.get(layerId)?.scene ?? null;
  }

  layerIdForSlot(slotId: number): string | null {
    return this.slotLayer.get(slotId) ?? null;
  }

  layers(): SceneLayerView[] {
    return [...this.byId.values()];
  }

  sortedLayers(): SceneLayerView[] {
    return [...this.byId.values()].sort((a, b) => {
      if (a.zOrder !== b.zOrder) return a.zOrder - b.zOrder;
      return a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0;
    });
  }

  resize(): void {
    for (const layer of this.byId.values()) {
      this.applyOrtho(layer);
      if (layer.rtt) {
        const width = Math.max(1, this.engine.getRenderWidth());
        const height = Math.max(1, this.engine.getRenderHeight());
        layer.rtt.resize({ width, height });
      }
    }
  }

  render(): void {
    for (const layer of this.sortedLayers()) {
      const record = layer as LayerRecord;
      if (record.rtt) {
        record.scene.autoClear = true;
        record.scene.render();
        this.blit(record);
      } else {
        record.scene.autoClear = false;
        record.scene.autoClearDepthAndStencil = true;
        record.scene.render();
      }
    }
  }

  pickHits(canvasX: number, canvasY: number): OverlayPointerHit[] {
    const hits: OverlayPointerHit[] = [];
    for (const layer of [...this.sortedLayers()].reverse()) {
      const pick = layer.scene.pick(canvasX, canvasY, undefined, false);
      if (!pick?.hit || !pick.pickedMesh) continue;
      let mesh: {
        name: string;
        parent: unknown;
        metadata?: unknown;
        isPickable?: boolean;
      } | null = pick.pickedMesh;
      let slotId: number | null = null;
      let metadata: OverlayMeshMetadata | null = overlayMetadataOf(mesh);
      while (mesh) {
        const match = /^actor-(\d+)$/.exec(mesh.name);
        if (match) {
          slotId = Number(match[1]);
          metadata = overlayMetadataOf(mesh) ?? metadata;
          break;
        }
        metadata = overlayMetadataOf(mesh) ?? metadata;
        mesh = (mesh.parent as typeof mesh) ?? null;
      }
      const actorGuid =
        metadata?.overlayActorGuid ??
        (slotId != null ? this.slotActor.get(slotId) : undefined) ??
        "";
      if (!actorGuid) continue;
      hits.push({
        layerId: layer.layerId,
        actorGuid,
        hitTest: parseSceneLayerHitTest(metadata?.overlayHitTest, "ignore"),
        hasButton: metadata?.overlayHasButton === true,
      });
    }
    return hits;
  }

  pickAt(
    canvasX: number,
    canvasY: number,
  ): {
    layerId: string;
    meshName: string;
    slotId: number | null;
    actorGuid: string | null;
    hitTest: SceneLayerHitTest;
    blocked: boolean;
    targets: OverlayPointerHit[];
  } | null {
    const hits = this.pickHits(canvasX, canvasY);
    const walked = walkOverlayPointerHits(hits);
    const first = walked.targets[0];
    if (!first) {
      return walked.blocked
        ? {
            layerId: "",
            meshName: "",
            slotId: null,
            actorGuid: null,
            hitTest: "block",
            blocked: true,
            targets: walked.targets,
          }
        : null;
    }
    return {
      layerId: first.layerId,
      meshName: first.actorGuid,
      slotId: null,
      actorGuid: first.actorGuid,
      hitTest: first.hitTest,
      blocked: walked.blocked,
      targets: walked.targets,
    };
  }

  dispose(): void {
    this.clear();
  }

  private applyOrtho(layer: LayerRecord): void {
    const width = Math.max(1, this.engine.getRenderWidth());
    const height = Math.max(1, this.engine.getRenderHeight());
    const aspect = width / height;
    layer.camera.orthoTop = this.orthoHalfHeight;
    layer.camera.orthoBottom = -this.orthoHalfHeight;
    layer.camera.orthoLeft = -this.orthoHalfHeight * aspect;
    layer.camera.orthoRight = this.orthoHalfHeight * aspect;
  }

  private rebuildPostProcess(layer: LayerRecord): void {
    this.releasePostProcess(layer);
    const enabledStack = layer.postProcessStack.filter((entry) => entry.enabled);
    if (
      !this.postProcessingEnabled() ||
      enabledStack.length === 0
    ) {
      layer.camera.outputRenderTarget = null;
      layer.scene.autoClear = false;
      layer.scene.autoClearDepthAndStencil = true;
      return;
    }
    const width = Math.max(1, this.engine.getRenderWidth());
    const height = Math.max(1, this.engine.getRenderHeight());
    layer.rtt = new RenderTargetTexture(
      `sceneLayerRtt:${layer.layerId}`,
      { width, height },
      layer.scene,
      false,
      true,
    );
    layer.camera.outputRenderTarget = layer.rtt;
    layer.scene.autoClear = true;
    this.attachLayerPostProcess?.(layer, enabledStack);
  }

  private releasePostProcess(layer: LayerRecord): void {
    layer.camera.outputRenderTarget = null;
    layer.rtt?.dispose();
    layer.rtt = null;
    layer.blitScene?.dispose();
    layer.blitScene = null;
    layer.blitMaterial = null;
  }

  private blit(layer: LayerRecord): void {
    if (!layer.rtt) return;
    if (!layer.blitScene) {
      const blitScene = new Scene(this.engine);
      blitScene.autoClear = false;
      blitScene.autoClearDepthAndStencil = false;
      blitScene.skipPointerMovePicking = true;
      blitScene.lightsEnabled = false;
      const camera = new UniversalCamera(
        "sceneLayerBlitCamera",
        new Vector3(0, 0, -1),
        blitScene,
      );
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -1;
      camera.orthoRight = 1;
      camera.orthoTop = 1;
      camera.orthoBottom = -1;
      blitScene.activeCamera = camera;
      const plane = MeshBuilder.CreatePlane(
        "sceneLayerBlitPlane",
        { size: 2 },
        blitScene,
      );
      const material = new StandardMaterial(
        `sceneLayerBlit:${layer.layerId}`,
        blitScene,
      );
      material.disableLighting = true;
      material.diffuseColor = Color3.White();
      material.emissiveColor = Color3.White();
      material.backFaceCulling = false;
      material.useAlphaFromDiffuseTexture = true;
      plane.material = material;
      layer.blitScene = blitScene;
      layer.blitMaterial = material;
    }
    if (layer.blitMaterial) {
      layer.blitMaterial.diffuseTexture = layer.rtt;
      layer.blitMaterial.emissiveTexture = layer.rtt;
    }
    layer.blitScene.render();
  }
}

type OverlayMeshMetadata = {
  overlayHitTest?: SceneLayerHitTest;
  overlayActorGuid?: string;
  overlayHasButton?: boolean;
};

function overlayMetadataOf(
  mesh: { metadata?: unknown } | null,
): OverlayMeshMetadata | null {
  if (!mesh?.metadata || typeof mesh.metadata !== "object") return null;
  return mesh.metadata as OverlayMeshMetadata;
}
