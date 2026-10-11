import {
  DirectionalLight,
  Matrix,
  Mesh,
  RenderTargetTexture,
  VertexBuffer,
  type AbstractMesh,
  type Geometry,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import { canCacheShadowMaterial } from "./shadow-material-policy";
import { hasRevisionTrackedCableGeometry } from "./cable-mesh";
import { hasRevisionTrackedDynamicMesh } from "./dynamic-runtime-mesh";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { isAutoLodMaster, peekAutoLodLevel } from "./model-lod";
import { casterWithinShadowRange } from "./shadow-mesh-policy";

/** Reused scalar/object snapshot; unchanged frames allocate no signature arrays. */
class Snapshot {
  private readonly values: unknown[] = [];
  private cursor = 0;
  changed = false;
  begin(): void {
    this.cursor = 0;
    this.changed = false;
  }
  value(value: unknown): void {
    if (!Object.is(this.values[this.cursor], value)) this.changed = true;
    this.values[this.cursor++] = value;
  }
  end(): void {
    if (this.values.length !== this.cursor) this.changed = true;
    this.values.length = this.cursor;
  }
}

type Caster = {
  snapshot: Snapshot;
  geometry: Geometry | null;
  world: Matrix | null;
  worldFlag: number;
  worldValue: Matrix;
  transformRevision: number;
  /** Bumped whenever this caster's shadow-relevant state changes. */
  revision: number;
  /** Visible content whose shadow can change without a tracked state change. */
  unsafe: boolean;
};

/**
 * Per-map invalidation for local maps with static opaque content. A local map
 * tracks only casters within its light's range: elsewhere a caster cannot
 * reach the map, whose depth range ends at that range.
 */
export class ShadowMapRefresh {
  private readonly casters = new Map<AbstractMesh, Caster>();
  private readonly maps = new WeakMap<ShadowGenerator, Snapshot>();
  /** Drawn level of each visible automatic-LOD caster for the scene camera. */
  private readonly lodLevels = new Map<AbstractMesh, number>();
  private readonly sceneState = new Snapshot();
  private revision = 0;
  private continuous = false;

  private readonly casterChanged: (mesh: AbstractMesh) => void;

  constructor(casterChanged: (mesh: AbstractMesh) => void) {
    this.casterChanged = casterChanged;
  }

  syncCasters(scene: Scene, meshes: ReadonlySet<AbstractMesh>): void {
    this.lodLevels.clear();
    // Removed casters leave each map's in-range list, which refreshes that map.
    for (const [mesh, record] of this.casters) {
      if (meshes.has(mesh)) continue;
      if (record.geometry) unwatchGeometry(record.geometry);
      this.casters.delete(mesh);
    }
    for (const mesh of meshes) {
      let record = this.casters.get(mesh);
      if (!record) {
        record = {
          snapshot: new Snapshot(),
          geometry: null,
          world: null,
          worldFlag: -1,
          worldValue: Matrix.Identity(),
          transformRevision: 0,
          revision: 0,
          unsafe: false,
        };
        this.casters.set(mesh, record);
      }
      const geometry = mesh instanceof Mesh ? mesh.geometry : null;
      if (record.geometry !== geometry) {
        if (record.geometry) unwatchGeometry(record.geometry);
        record.geometry = geometry;
        if (geometry) watchGeometry(geometry);
      }
      // Null once another owner replaced the shared update hook: updates are no longer counted.
      const geometryWatch = geometry ? geometryRevision(geometry) : null;
      const state = record.snapshot;
      state.begin();
      // freezeWorldMatrix(matrix), used by bone attachments, can replace/update
      // a frozen matrix without firing onAfterWorldMatrixUpdateObservable.
      const world = mesh.computeWorldMatrix();
      if (world !== record.world || world.updateFlag !== record.worldFlag) {
        if (!world.equals(record.worldValue)) record.transformRevision++;
        record.worldValue.copyFrom(world);
        record.world = world;
        record.worldFlag = world.updateFlag;
      }
      state.value(record.transformRevision);
      state.value(geometry);
      state.value(geometryWatch?.revision);
      state.value(mesh.isEnabled());
      state.value(mesh.isVisible);
      state.value(mesh.visibility);
      state.value(mesh instanceof Mesh ? mesh.sideOrientation : undefined);
      state.value(mesh.skeleton);
      state.value(mesh.morphTargetManager);
      state.value(mesh.subMeshes);
      // Babylon leaves this unset on empty model/tilemap roots until geometry
      // creates their first SubMesh. Keep tracking the later populated list.
      if (mesh.subMeshes)
        for (const part of mesh.subMeshes) {
          state.value(part);
          state.value(part.indexStart);
          state.value(part.indexCount);
          state.value(part.verticesStart);
          state.value(part.verticesCount);
          state.value(part.materialIndex);
        }
      const material = mesh.material ?? scene.defaultMaterial;
      state.value(material);
      state.value(material.alpha);
      state.value(material.fillMode);
      state.value(material.backFaceCulling);
      state.value(material.cullBackFaces);
      state.value(material.sideOrientation);
      state.value(material.zOffset);
      state.value(material.zOffsetUnits);
      state.value(material.depthFunction);
      state.value(material.disableDepthWrite);
      state.value(material.forceDepthWrite);
      state.value(material.useLogarithmicDepth);
      state.value(material.needDepthPrePass);
      state.value(material.pointSize);
      state.value(material.shadowDepthWrapper);
      state.value(material.metadata?.boundsPadding);
      const safeMaterial = canCacheShadowMaterial(material, mesh);
      state.value(safeMaterial);
      // Automatic LOD levels are immutable index buffers that mirror this
      // mesh's material. Only maps that can see this caster track its level.
      const autoLod = isAutoLodMaster(mesh);
      // Babylon 9.29 has no public index-mutability getter. updateIndices skips
      // onGeometryUpdated for an existing dynamic buffer, including GPU-only
      // updates, so only the known immutable state is eligible for caching.
      const trackedDynamic = mesh instanceof Mesh && hasRevisionTrackedDynamicMesh(mesh);
      let dynamicGeometry =
        !trackedDynamic && (!geometry || Reflect.get(geometry, "_indexBufferIsUpdatable") !== false);
      const buffers = geometry?.getVertexBuffers();
      const trackedCable = mesh instanceof Mesh && hasRevisionTrackedCableGeometry(mesh);
      if (buffers)
        for (const kind in buffers)
          if (buffers[kind]?.isUpdatable() && !trackedDynamic && !(trackedCable && (kind === VertexBuffer.PositionKind || kind === VertexBuffer.NormalKind))) dynamicGeometry = true;
      const safeMesh =
        mesh instanceof Mesh &&
        !dynamicGeometry &&
        !mesh.infiniteDistance &&
        mesh.billboardMode === Mesh.BILLBOARDMODE_NONE &&
        (autoLod || !mesh.getLODLevels().length) &&
        !mesh.onBeforeRenderObservable.hasObservers() &&
        !mesh.onBeforeDrawObservable.hasObservers() &&
        (!geometry || geometryWatch !== null);
      state.value(safeMesh);
      state.end();
      if (state.changed) {
        record.revision++;
        this.casterChanged(mesh);
      }
      const visible = mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0;
      record.unsafe = visible && (!safeMesh || !safeMaterial);
      if (visible && autoLod) this.lodLevels.set(mesh, peekAutoLodLevel(mesh, scene.activeCamera) ?? 0);
    }
    const state = this.sceneState;
    state.begin();
    state.value(scene.activeCamera);
    state.value(scene.floatingOriginOffset.x);
    state.value(scene.floatingOriginOffset.y);
    state.value(scene.floatingOriginOffset.z);
    state.value(scene.forceWireframe);
    state.value(scene.forcePointsCloud);
    state.value(scene.useRightHandedSystem);
    state.end();
    this.continuous = !!(
      scene.clipPlane ||
      scene.clipPlane2 ||
      scene.clipPlane3 ||
      scene.clipPlane4 ||
      scene.clipPlane5 ||
      scene.clipPlane6
    );
    if (state.changed) this.revision++;
  }

  apply(generator: ShadowGenerator): void {
    const map = generator.getShadowMap();
    if (!map) return;
    const light = generator.getLight();
    const scene = light.getScene();
    let state = this.maps.get(generator);
    if (!state) {
      state = new Snapshot();
      this.maps.set(generator, state);
    }
    state.begin();
    state.value(map);
    state.value(this.revision);
    light.parent?.computeWorldMatrix(true);
    const transformed = light.computeTransformedInformation();
    const position = transformed ? light.transformedPosition! : light.position;
    // Cube face axes are fixed; PointLight.getShadowDirection allocates a vector.
    const direction = light.needCube() ? null : light.getShadowDirection(0);
    state.value(position.x);
    state.value(position.y);
    state.value(position.z);
    state.value(direction?.x);
    state.value(direction?.y);
    state.value(direction?.z);
    state.value(light.getDepthMinZ(scene.activeCamera));
    state.value(light.getDepthMaxZ(scene.activeCamera));
    // Scalar projection/filter changes retain the allocation but change its texels.
    state.value(light.range);
    state.value("angle" in light ? light.angle : undefined);
    state.value(
      "shadowAngleScale" in light ? light.shadowAngleScale : undefined,
    );
    state.value("shadowAngle" in light ? light.shadowAngle : undefined);
    state.value(generator.bias);
    state.value(generator.normalBias);
    state.value(generator.filter);
    state.value(generator.filteringQuality);
    state.value(generator.contactHardeningLightSizeUVRatio);
    state.value(generator.forceBackFacesOnly);
    state.value(generator.transparencyShadow);
    state.value(generator.enableSoftTransparentShadow);
    state.value(generator.useOpacityTextureForTransparentShadow);
    const directional = light instanceof DirectionalLight;
    let continuous =
      this.continuous ||
      directional ||
      !!light.customProjectionMatrixBuilder ||
      !!generator.customShaderOptions;
    if (!continuous) {
      // A local map re-renders once when a caster within its range changes,
      // enters or leaves, or changes the level the camera draws; unrelated
      // casters elsewhere in the scene do not touch it.
      const range = "range" in light && Number.isFinite(light.range) ? light.range : Infinity;
      for (const [mesh, record] of this.casters) {
        if (!casterWithinShadowRange(mesh, position, range)) continue;
        if (record.unsafe) {
          continuous = true;
          break;
        }
        state.value(mesh);
        state.value(record.revision);
        const level = this.lodLevels.get(mesh);
        if (level !== undefined) state.value(level);
      }
    }
    state.end();
    const rate = continuous
      ? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME
      : RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    if (map.refreshRate !== rate) map.refreshRate = rate;
    else if (!continuous && state.changed) map.resetRefreshCounter();
    // No completion observer: readiness probes also emit onAfterUnbind without
    // drawing. Babylon consumes the refresh only at its real target-render gate,
    // and retries automatically when a caster's shader is not ready.
  }

  dispose(): void {
    for (const record of this.casters.values())
      if (record.geometry) unwatchGeometry(record.geometry);
    this.casters.clear();
    this.lodLevels.clear();
  }
}
