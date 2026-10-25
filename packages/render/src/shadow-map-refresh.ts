import {
  Camera,
  CascadedShadowGenerator,
  DirectionalLight,
  InstancedMesh,
  Matrix,
  Mesh,
  RenderTargetTexture,
  VertexBuffer,
  type AbstractMesh,
  type Geometry,
  type Scene,
  type ShadowGenerator,
  type Vector3,
} from "@babylonjs/core";
import { canCacheShadowMaterial } from "./shadow-material-policy";
import { hasRevisionTrackedCableGeometry } from "./cable-mesh";
import { hasRevisionTrackedDynamicMesh } from "./dynamic-runtime-mesh";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { isAutoLodMaster, peekAutoLodLevel } from "./model-lod";
import { casterWithinShadowRange, hasDeformingShadowBounds } from "./shadow-mesh-policy";

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

/** Cascade transform matrices (4 x 16) of a cascaded map's last actual pass. */
type DrawnFit = { matrices: Float64Array; valid: boolean };

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
 * Whether a world sphere may touch the light-space rectangle of any cascade
 * (given as transform matrices with the world scale of their x and y axes).
 * Depth is ignored: casters toward the light are clamped into the map.
 */
function reachesCascade(
  matrices: readonly ArrayLike<number>[],
  scales: Float64Array,
  center: Vector3,
  radius: number,
): boolean {
  for (let cascade = 0; cascade < matrices.length; cascade++) {
    const m = matrices[cascade]!;
    const x = center.x * m[0]! + center.y * m[4]! + center.z * m[8]! + m[12]!;
    const y = center.x * m[1]! + center.y * m[5]! + center.z * m[9]! + m[13]!;
    // Negated so a non-finite value stays inside, never wrongly outside.
    if (!(Math.abs(x) > 1 + radius * scales[2 * cascade]! || Math.abs(y) > 1 + radius * scales[2 * cascade + 1]!)) return true;
  }
  return false;
}

/**
 * Per-map invalidation for shadow maps with static opaque content. A local map
 * tracks only casters within its light's range: elsewhere a caster cannot
 * reach the map, whose depth range ends at that range. A cascaded sun map
 * tracks the camera, the light and its own cascade settings, and only the
 * casters that can reach a cascade's light-space rectangle. A single-map sun
 * (custom projection) is always drawn.
 */
export class ShadowMapRefresh {
  private readonly casters = new Map<AbstractMesh, Caster>();
  /** Scratch for the cascaded map being applied: transform matrices, then x/y axis scales per cascade. */
  private readonly cascadeMatrices: ArrayLike<number>[] = [];
  private readonly cascadeScales = new Float64Array(8);
  private readonly drawnFits = new WeakMap<RenderTargetTexture, DrawnFit>();
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

  /**
   * The part of a walk that cannot wait for a map: it releases removed casters
   * so they are not retained. Snapshots of the others stay, so a later walk
   * reports only what changed in between.
   */
  dropRemovedCasters(meshes: ReadonlySet<AbstractMesh>): void {
    this.lodLevels.clear();
    // Removed casters leave each map's in-range list, which refreshes that map.
    for (const [mesh, record] of this.casters) {
      if (meshes.has(mesh)) continue;
      if (record.geometry) unwatchGeometry(record.geometry);
      this.casters.delete(mesh);
    }
  }

  syncCasters(scene: Scene, meshes: ReadonlySet<AbstractMesh>): void {
    this.dropRemovedCasters(meshes);
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
      // An instance draws its source's geometry, sub-meshes and material at its own world matrix: its shadow content is
      // its source's, posed and shown by the instance itself.
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
      const geometry = source instanceof Mesh ? source.geometry : null;
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
      const enabled = mesh.isEnabled();
      state.value(enabled);
      state.value(mesh.isVisible);
      state.value(mesh.visibility);
      state.value(source instanceof Mesh ? source.sideOrientation : undefined);
      state.value(source.skeleton);
      state.value(source.morphTargetManager);
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
      const trackedDynamic = source instanceof Mesh && hasRevisionTrackedDynamicMesh(source);
      let dynamicGeometry =
        !trackedDynamic && (!geometry || Reflect.get(geometry, "_indexBufferIsUpdatable") !== false);
      const buffers = geometry?.getVertexBuffers();
      const trackedCable = source instanceof Mesh && hasRevisionTrackedCableGeometry(source);
      if (buffers)
        for (const kind in buffers)
          if (buffers[kind]?.isUpdatable() && !trackedDynamic && !(trackedCable && (kind === VertexBuffer.PositionKind || kind === VertexBuffer.NormalKind))) dynamicGeometry = true;
      // An instance of a mesh with levels of detail draws the level its source selects: it keeps refreshing.
      const safeMesh =
        source instanceof Mesh &&
        !dynamicGeometry &&
        !mesh.infiniteDistance &&
        mesh.billboardMode === Mesh.BILLBOARDMODE_NONE &&
        (source === mesh ? autoLod || !source.getLODLevels().length : !source.getLODLevels().length) &&
        !source.onBeforeRenderObservable.hasObservers() &&
        !source.onBeforeDrawObservable.hasObservers() &&
        (!geometry || geometryWatch !== null);
      state.value(safeMesh);
      state.end();
      if (state.changed) {
        record.revision++;
        this.casterChanged(mesh);
      }
      const visible = enabled && mesh.isVisible && mesh.visibility > 0;
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
    const cascadedSun = generator instanceof CascadedShadowGenerator ? generator : null;
    let continuous: boolean =
      this.continuous ||
      (light instanceof DirectionalLight && !cascadedSun) ||
      !!light.customProjectionMatrixBuilder ||
      !!generator.customShaderOptions;
    if (!continuous && cascadedSun) {
      continuous = this.trackCascades(cascadedSun, map, state);
    } else if (!continuous) {
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

  /**
   * Records what a cascaded sun map is fitted and drawn from, and reports
   * whether content that changes without a tracked state change reaches it.
   *
   * Babylon refits the cascades whenever the map binds, a readiness probe
   * (possibly another camera's) included, and the receivers then use that fit.
   * So the snapshot holds what a fresh fit depends on and a render must follow:
   * the camera's view and projection, the cascade settings and, from the
   * caller, the light direction. Separately, the fit the generator holds must be
   * the one of the pass that drew the retained depth: a probe that refit it
   * differently marks the snapshot changed. The casters follow the local-map
   * rule: one that cannot reach any cascade's light-space rectangle is not drawn
   * into the map. Deforming geometry is drawn whatever its bounds, so it
   * reaches within the shadow distance of the camera as well.
   */
  private trackCascades(generator: CascadedShadowGenerator, map: RenderTargetTexture, state: Snapshot): boolean {
    const camera: Camera | null = generator.camera ?? generator.getLight().getScene().activeCamera;
    const view = camera?.getViewMatrix().m;
    const projection = camera?.getProjectionMatrix().m;
    for (let index = 0; index < 16; index++) {
      state.value(view?.[index]);
      state.value(projection?.[index]);
    }
    state.value(generator.numCascades);
    state.value(generator.lambda);
    state.value(generator.shadowMaxZ);
    state.value(generator.stabilizeCascades);
    state.value(generator.depthClamp);
    // The held fit places each cascade for the reach test. It is stale only
    // after a camera or light change, which renders the map this frame anyway.
    const drawn = this.drawnFit(generator, map);
    let refit = !drawn.valid;
    const matrices = this.cascadeMatrices;
    matrices.length = 0;
    for (let cascade = 0; cascade < generator.numCascades; cascade++) {
      const m = generator.getCascadeTransformMatrix(cascade)?.m;
      if (!m) {
        // No fit to test against: every caster may reach.
        matrices.length = 0;
        refit = true;
        break;
      }
      for (let index = 0; index < 16; index++) if (drawn.matrices[16 * cascade + index] !== m[index]) refit = true;
      this.cascadeScales[2 * cascade] = Math.hypot(m[0]!, m[4]!, m[8]!);
      this.cascadeScales[2 * cascade + 1] = Math.hypot(m[1]!, m[5]!, m[9]!);
      matrices.push(m);
    }
    if (refit) state.changed = true;
    const eye = camera?.globalPosition;
    const orthographic = camera?.mode === Camera.ORTHOGRAPHIC_CAMERA;
    for (const [mesh, record] of this.casters) {
      if (matrices.length) {
        const sphere = mesh.getBoundingInfo().boundingSphere;
        const center = sphere.centerWorld;
        const radius = sphere.radiusWorld;
        if (!reachesCascade(matrices, this.cascadeScales, center, radius)) {
          // Deforming geometry is drawn into the cascades whatever its bounds: no
          // plane culls it, and its skin can leave its bind-pose bounds anywhere.
          // So a visible one within the shadow distance of the camera (or near a
          // rectangle) reaches; any other caster out of reach is not drawn.
          if (!record.unsafe || !hasDeformingShadowBounds(mesh)) continue;
          if (!reachesCascade(matrices, this.cascadeScales, center, 2 * radius) && eye && !orthographic) {
            const limit = generator.shadowMaxZ + 2 * radius;
            const dx = center.x - eye.x;
            const dy = center.y - eye.y;
            const dz = center.z - eye.z;
            // Not negated: a non-finite distance reaches.
            if (dx * dx + dy * dy + dz * dz > limit * limit) continue;
          }
        }
      }
      if (record.unsafe) return true;
      state.value(mesh);
      state.value(record.revision);
      const level = this.lodLevels.get(mesh);
      if (level !== undefined) state.value(level);
    }
    return false;
  }

  /** The cascade matrices of the map's last actual pass, kept by a clear observer. */
  private drawnFit(generator: CascadedShadowGenerator, map: RenderTargetTexture): DrawnFit {
    const existing = this.drawnFits.get(map);
    if (existing) return existing;
    const fit: DrawnFit = { matrices: new Float64Array(16 * 4), valid: false };
    this.drawnFits.set(map, fit);
    // Only an actual pass clears (probes emit the other render events), and the
    // map refit its cascades for that pass before it did.
    map.onClearObservable.add(() => {
      for (let cascade = 0; cascade < generator.numCascades; cascade++) {
        const m = generator.getCascadeTransformMatrix(cascade)?.m;
        if (m) for (let index = 0; index < 16; index++) fit.matrices[16 * cascade + index] = m[index]!;
      }
      fit.valid = true;
    });
    return fit;
  }

  dispose(): void {
    for (const record of this.casters.values())
      if (record.geometry) unwatchGeometry(record.geometry);
    this.casters.clear();
    this.lodLevels.clear();
  }
}
