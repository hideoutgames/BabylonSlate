import {
  DirectionalLight,
  Matrix,
  Mesh,
  RenderTargetTexture,
  type AbstractMesh,
  type Geometry,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import { canCacheShadowMaterial } from "./shadow-material-policy";

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

type GeometryWatch = {
  users: number;
  revision: number;
  previous: Geometry["onGeometryUpdated"];
  notify: Geometry["onGeometryUpdated"];
};
type Caster = {
  snapshot: Snapshot;
  geometry: Geometry | null;
  world: Matrix | null;
  worldFlag: number;
  worldValue: Matrix;
  transformRevision: number;
};

/** Conservative scene-wide invalidation for local maps with static opaque content. */
export class ShadowMapRefresh {
  private readonly casters = new Map<AbstractMesh, Caster>();
  private readonly geometries = new Map<Geometry, GeometryWatch>();
  private readonly maps = new WeakMap<ShadowGenerator, Snapshot>();
  private readonly sceneState = new Snapshot();
  private revision = 0;
  private continuous = false;

  constructor(private readonly casterChanged: (mesh: AbstractMesh) => void) {}

  private watch(geometry: Geometry): void {
    const existing = this.geometries.get(geometry);
    if (existing) {
      existing.users++;
      return;
    }
    const previous = geometry.onGeometryUpdated;
    const record: GeometryWatch = {
      users: 1,
      revision: 0,
      previous,
      notify: (changed, kind) => {
        previous?.call(geometry, changed, kind);
        record.revision++;
      },
    };
    geometry.onGeometryUpdated = record.notify;
    this.geometries.set(geometry, record);
  }

  private unwatch(geometry: Geometry): void {
    const record = this.geometries.get(geometry);
    if (!record || --record.users > 0) return;
    if (geometry.onGeometryUpdated === record.notify)
      geometry.onGeometryUpdated = record.previous;
    this.geometries.delete(geometry);
  }

  syncCasters(scene: Scene, meshes: ReadonlySet<AbstractMesh>): void {
    let changed = false;
    let continuous = false;
    for (const [mesh, record] of this.casters) {
      if (meshes.has(mesh)) continue;
      if (record.geometry) this.unwatch(record.geometry);
      this.casters.delete(mesh);
      changed = true;
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
        };
        this.casters.set(mesh, record);
        changed = true;
      }
      const geometry = mesh instanceof Mesh ? mesh.geometry : null;
      if (record.geometry !== geometry) {
        if (record.geometry) this.unwatch(record.geometry);
        record.geometry = geometry;
        if (geometry) this.watch(geometry);
      }
      const geometryWatch = geometry ? this.geometries.get(geometry) : null;
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
      // Babylon 9.20 has no public index-mutability getter. updateIndices skips
      // onGeometryUpdated for an existing dynamic buffer, including GPU-only
      // updates, so only the known immutable state is eligible for caching.
      let dynamicGeometry =
        !geometry || Reflect.get(geometry, "_indexBufferIsUpdatable") !== false;
      const buffers = geometry?.getVertexBuffers();
      if (buffers)
        for (const kind in buffers)
          if (buffers[kind]?.isUpdatable()) dynamicGeometry = true;
      const safeMesh =
        mesh instanceof Mesh &&
        !dynamicGeometry &&
        !mesh.infiniteDistance &&
        mesh.billboardMode === Mesh.BILLBOARDMODE_NONE &&
        !mesh.getLODLevels().length &&
        !mesh.onBeforeRenderObservable.hasObservers() &&
        !mesh.onBeforeDrawObservable.hasObservers() &&
        geometryWatch?.notify === geometry?.onGeometryUpdated;
      state.value(safeMesh);
      state.end();
      if (state.changed) {
        changed = true;
        this.casterChanged(mesh);
      }
      if (mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0)
        continuous ||= !safeMesh || !safeMaterial;
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
    continuous ||= !!(
      scene.clipPlane ||
      scene.clipPlane2 ||
      scene.clipPlane3 ||
      scene.clipPlane4 ||
      scene.clipPlane5 ||
      scene.clipPlane6
    );
    if (changed || state.changed) this.revision++;
    this.continuous = continuous;
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
    state.end();
    const continuous =
      this.continuous ||
      light instanceof DirectionalLight ||
      !!light.customProjectionMatrixBuilder ||
      !!generator.customShaderOptions;
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
      if (record.geometry) this.unwatch(record.geometry);
    this.casters.clear();
  }
}
