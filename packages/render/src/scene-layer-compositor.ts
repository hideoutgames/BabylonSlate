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
  sceneLayerOrthoBounds,
  walkOverlayPointerHits,
  type OverlayPointerHit,
  type SceneLayerHitTest,
} from "@babylonslate/core";
import { installEngineDefaultMaterial } from "./default-material";
import {
  overlayCanvasToWorld,
  overlayMinTargetWorldSize,
  pointInInflatedWorldAabb,
} from "./overlay-touch-target";

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
  postProcessingEnabled?: () => boolean;
  attachLayerPostProcess?: (
    layer: SceneLayerView,
    stack: SceneLayerPostProcessEntry[],
  ) => { dispose: () => void } | null;
}

type LayerRecord = SceneLayerView & {
  layerBounds: { width: number; height: number };
  postProcessStack: SceneLayerPostProcessEntry[];
  rtt: RenderTargetTexture | null;
  blitMaterial: StandardMaterial | null;
  blitScene: Scene | null;
  attachedPostProcess: { dispose: () => void } | null;
};

/**
 * Play-only overlay stack: extra unlit orthographic Scenes on the shared
 * Engine, drawn after the world camera (and its post-process).
 */
export class SceneLayerCompositor {
  private readonly engine: Engine;
  private readonly postProcessingEnabled: () => boolean;
  private readonly attachLayerPostProcess?: SceneLayerCompositorOptions["attachLayerPostProcess"];
  private readonly byId = new Map<string, LayerRecord>();
  private readonly slotLayer = new Map<number, string>();
  private readonly slotActor = new Map<number, string>();

  constructor(options: SceneLayerCompositorOptions) {
    this.engine = options.engine;
    this.postProcessingEnabled = options.postProcessingEnabled ?? (() => true);
    this.attachLayerPostProcess = options.attachLayerPostProcess;
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
      layerBounds: sceneLayerOrthoBounds(command.layerBounds),
      postProcessStack: command.postProcessStack.map((entry) => ({ ...entry })),
      rtt: null,
      blitMaterial: null,
      blitScene: null,
      attachedPostProcess: null,
    };
    this.bindHudCamera(layer);
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

  slotIdsForLayer(layerId: string): number[] {
    const slotIds: number[] = [];
    for (const [slotId, id] of this.slotLayer) {
      if (id === layerId) slotIds.push(slotId);
    }
    return slotIds;
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
      this.bindHudCamera(layer);
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
      this.bindHudCamera(record);
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

  pickHits(
    canvasX: number,
    canvasY: number,
    options?: { minTargetPx?: number; canvasCssHeight?: number },
  ): OverlayPointerHit[] {
    const hits: OverlayPointerHit[] = [];
    const seen = new Set<string>();
    const renderWidth = Math.max(1, this.engine.getRenderWidth());
    const renderHeight = Math.max(1, this.engine.getRenderHeight());

    const pushHit = (
      layerId: string,
      actorGuid: string,
      hitTest: SceneLayerHitTest,
      hasButton: boolean,
      componentId?: string,
    ) => {
      const key = componentId ? `${actorGuid}:${componentId}` : actorGuid;
      if (!actorGuid || seen.has(key)) return;
      seen.add(key);
      hits.push({
        layerId,
        actorGuid,
        hitTest,
        hasButton,
        ...(componentId ? { componentId } : {}),
      });
    };

    for (const layer of [...this.sortedLayers()].reverse()) {
      layer.scene.updateTransformMatrix();
      const pick = layer.scene.pick(canvasX, canvasY, undefined, false);
      if (pick?.hit && pick.pickedMesh) {
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
        if (actorGuid) {
          pushHit(
            layer.layerId,
            actorGuid,
            parseSceneLayerHitTest(metadata?.overlayHitTest, "ignore"),
            metadata?.overlayHasButton === true,
            typeof metadata?.overlayButtonComponentId === "string" &&
              metadata.overlayButtonComponentId
              ? metadata.overlayButtonComponentId
              : undefined,
          );
        }
      }

      const minWorld = overlayMinTargetWorldSize(
        options?.minTargetPx ?? 0,
        options?.canvasCssHeight ?? 0,
        layer.layerBounds.height,
      );
      if (!(minWorld > 0)) continue;
      const world = overlayCanvasToWorld(
        canvasX,
        canvasY,
        renderWidth,
        renderHeight,
        layer.layerBounds.width / 2,
        layer.layerBounds.height / 2,
      );
      for (const mesh of layer.scene.meshes) {
        const metadata = overlayMetadataOf(mesh);
        if (!metadata?.overlayHasButton) continue;
        const hitTest = parseSceneLayerHitTest(metadata.overlayHitTest, "ignore");
        if (hitTest === "ignore") continue;
        const slotMatch = /^actor-(\d+)$/.exec(mesh.name);
        const actorGuid =
          metadata.overlayActorGuid ??
          (slotMatch ? this.slotActor.get(Number(slotMatch[1])) : undefined) ??
          "";
        if (!actorGuid) continue;
        mesh.computeWorldMatrix(true);
        const box = mesh.getBoundingInfo().boundingBox;
        if (
          !pointInInflatedWorldAabb(
            world.x,
            world.y,
            box.centerWorld.x,
            box.centerWorld.y,
            box.extendSizeWorld.x,
            box.extendSizeWorld.y,
            minWorld,
          )
        ) {
          continue;
        }
        pushHit(
          layer.layerId,
          actorGuid,
          hitTest,
          true,
          typeof metadata.overlayButtonComponentId === "string" &&
            metadata.overlayButtonComponentId
            ? metadata.overlayButtonComponentId
            : undefined,
        );
      }
    }
    return hits;
  }

  pickAt(
    canvasX: number,
    canvasY: number,
    options?: { minTargetPx?: number; canvasCssHeight?: number },
  ): {
    layerId: string;
    meshName: string;
    slotId: number | null;
    actorGuid: string | null;
    hitTest: SceneLayerHitTest;
    blocked: boolean;
    targets: OverlayPointerHit[];
  } | null {
    const hits = this.pickHits(canvasX, canvasY, options);
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

  private bindHudCamera(layer: LayerRecord): void {
    layer.camera.parent = null;
    layer.camera.position.set(0, 0, -10);
    layer.camera.rotation.set(0, 0, 0);
    if (layer.camera.rotationQuaternion) {
      layer.camera.rotationQuaternion.set(0, 0, 0, 1);
    }
    layer.camera.setTarget(Vector3.Zero());
    layer.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    layer.scene.activeCamera = layer.camera;
    this.applyOrtho(layer);
    layer.camera.getViewMatrix(true);
    layer.camera.getProjectionMatrix(true);
    layer.scene.updateTransformMatrix();
  }

  private applyOrtho(layer: LayerRecord): void {
    const halfW = layer.layerBounds.width / 2;
    const halfH = layer.layerBounds.height / 2;
    layer.camera.orthoTop = halfH;
    layer.camera.orthoBottom = -halfH;
    layer.camera.orthoLeft = -halfW;
    layer.camera.orthoRight = halfW;
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
    layer.attachedPostProcess =
      this.attachLayerPostProcess?.(layer, enabledStack) ?? null;
  }

  private releasePostProcess(layer: LayerRecord): void {
    layer.attachedPostProcess?.dispose();
    layer.attachedPostProcess = null;
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
  overlayButtonComponentId?: string;
};

function overlayMetadataOf(
  mesh: { metadata?: unknown } | null,
): OverlayMeshMetadata | null {
  if (!mesh?.metadata || typeof mesh.metadata !== "object") return null;
  return mesh.metadata as OverlayMeshMetadata;
}
