import { InstancedMesh, Material, Mesh, MultiMaterial, type AbstractMesh, type Scene } from "@babylonjs/core";
import { hasStockVertexStage } from "./shadow-material-policy";
import { hasPerMeshBindings } from "./unlit-material-blocks";
import { hasDeformingShadowBounds } from "./shadow-mesh-policy";
import { markInstanceSource } from "./instance-source";
import { hasDrawn } from "./reveal-pending";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

/**
 * Automatic instancing: a per-Scene pool of hidden source meshes whose regular instances draw actors that share a
 * geometry and a Material, one batch per group. Each member keeps its own node (transform, parent, animation target,
 * visibility, picking, bounds and casting); the group's source holds what Babylon reads from the source for every
 * instance (Material, receiving shadows, rendering group). The pool is not wired to any visual yet.
 */

/** Where a group's geometry comes from: a cached model's leaf or a per-Scene primitive template. */
export interface InstanceGeometry {
  /** Identifies the geometry: `CachedGlb.key` and the container mesh index, or `primitive:<kind>`. */
  readonly key: string;
  /** Builds the group's source, sharing the geometry (`clone(name, null, true)` or a template clone). */
  build(scene: Scene, name: string): Mesh;
  /** Takes the group's hold on what the geometry belongs to (a container lease); returns its release. */
  retain?(): () => void;
}

/** What Babylon reads from the source for every instance, so members that differ in it cannot draw together. */
export interface InstanceGroupKey {
  readonly geometry: InstanceGeometry;
  /** Null draws with `scene.defaultMaterial`. */
  readonly material: Material | null;
  readonly receiveShadows: boolean;
  readonly renderingGroupId: number;
}

/** Why a mesh draws unpooled (v1). */
export type InstancingIneligibility =
  | "deforming" | "thinInstances" | "levelsOfDetail" | "instanced" | "drawHooks" | "partitioned" | "sorted"
  | "blended" | "vertexStage" | "fillMode" | "perMeshBinding";

/** Why a group cannot draw `material` on `mesh`'s geometry (blending, fill mode, vertex stage), or null. */
export function materialIneligibility(mesh: AbstractMesh, material: Material): InstancingIneligibility | null {
  if (material instanceof MultiMaterial) {
    for (const part of material.subMaterials) {
      const reason = part ? materialIneligibility(mesh, part) : null;
      if (reason) return reason;
    }
    return null;
  }
  if (material.needAlphaBlendingForMesh(mesh)) return "blended";
  // The unlit Material binds each mesh's texture and colour; a group's instances all draw their source's.
  if (hasPerMeshBindings(material)) return "perMeshBinding";
  if (material.fillMode !== Material.TriangleFillMode || material.wireframe || material.pointsCloud) return "fillMode";
  // World Position Offset and other authored vertex stages: an instance's bounds and the CPU pick must stay exact.
  return hasStockVertexStage(material) ? null : "vertexStage";
}

/**
 * Why `mesh`, drawn with `material`, cannot join a group, or null when it can: its vertices must stay inside its
 * bounds (no skinning, morphs, baked animation, lattice or padded bounds), it draws one batch of its own (no thin
 * instances, levels of detail, instances or split shadow ranges), Babylon draws it with nothing per mesh (no draw
 * hooks, no sorting order), and its Material is opaque triangles with the stock vertex stage.
 */
export function instancingIneligibility(mesh: Mesh, material: Material | null): InstancingIneligibility | null {
  if (hasDeformingShadowBounds(mesh)) return "deforming";
  if (mesh.hasThinInstances) return "thinInstances";
  if (mesh.getLODLevels().length > 0) return "levelsOfDetail";
  if (mesh.instances.length > 0) return "instanced";
  if (mesh.onBeforeRenderObservable.hasObservers() || mesh.onBeforeBindObservable.hasObservers() ||
    mesh.onBeforeDrawObservable.hasObservers()) return "drawHooks";
  // `partitionShadowGeometry` splits a large mesh's index ranges into submeshes of one Material each.
  const ranges = new Set((mesh.subMeshes ?? []).map((part) => part.materialIndex));
  if ((mesh.subMeshes?.length ?? 0) > ranges.size) return "partitioned";
  if (mesh.alphaIndex !== Number.MAX_VALUE) return "sorted";
  return materialIneligibility(mesh, material ?? mesh.getScene().defaultMaterial);
}

/** A group's empty drawn sources kept for a respawn, beyond which the least recently emptied is disposed. */
export const RETAINED_EMPTY_GROUPS = 32;

export interface InstancePoolDiagnostics {
  /** Groups with members. */
  groups: number;
  /** Empty drawn groups kept for a respawn. */
  retained: number;
  /** Members drawing through the pool. */
  pooled: number;
  /** Members moved to another group (a Material, receive or rendering group change). */
  rekeys: number;
  /** Meshes left unpooled, by reason (`noteUnpooled`). */
  unpooled: Partial<Record<InstancingIneligibility, number>>;
}

interface InstanceGroup {
  readonly id: string;
  readonly key: InstanceGroupKey;
  readonly source: Mesh;
  readonly members: Set<InstancedMesh>;
  /** Some member has drawn: the group's variants and pipelines exist. */
  drawn: boolean;
  release: (() => void) | undefined;
}

/** Shadow participation the source carries: never a caster (members cast), receiving as its key says. */
interface SourceShadowParticipation {
  castShadows: false;
  receiveShadows: boolean;
}

const materialIds = new WeakMap<Material, number>();
let nextMaterialId = 1;
function materialId(material: Material | null): number {
  if (!material) return 0;
  let id = materialIds.get(material);
  if (id === undefined) materialIds.set(material, (id = nextMaterialId++));
  return id;
}

function groupId(key: InstanceGroupKey): string {
  return `${key.geometry.key}|${materialId(key.material)}|${key.receiveShadows ? 1 : 0}|${key.renderingGroupId}`;
}

const sources = new WeakSet<Mesh>();

/** Whether `mesh` is a pool group's hidden source. */
export function isInstancePoolSource(mesh: Mesh): boolean {
  return sources.has(mesh);
}

export class SceneInstancePool {
  private readonly scene: Scene;
  private readonly groups = new Map<string, InstanceGroup>();
  /** Empty drawn groups, least recently emptied first. */
  private readonly retained = new Map<string, InstanceGroup>();
  private readonly memberGroups = new WeakMap<InstancedMesh, InstanceGroup>();
  private rekeys = 0;
  private sourceCount = 0;
  private readonly unpooled: Partial<Record<InstancingIneligibility, number>> = {};

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** A new member of `key`'s group, at the origin, unparented; the caller places and parents it. */
  join(key: InstanceGroupKey, name: string): InstancedMesh {
    const group = this.group(key);
    const member = new InstancedMesh(name, group.source);
    this.memberGroups.set(member, group);
    group.members.add(member);
    member.onDisposeObservable.addOnce(() => this.left(member));
    return member;
  }

  /**
   * Moves `member` to `key`'s group in place, keeping its identity (uniqueId, parent, animation targets and every
   * record keyed by it): a Material, receive or rendering group change. The geometry must stay the same.
   */
  rekey(member: InstancedMesh, key: InstanceGroupKey): void {
    const previous = this.memberGroups.get(member);
    if (!previous) throw new Error(`"${member.name}" is not a member of the instance pool`);
    if (previous.key.geometry.key !== key.geometry.key) throw new Error(`"${member.name}" cannot change geometry in place`);
    const next = this.group(key);
    if (next === previous) return;
    if (hasDrawn(member)) previous.drawn = true;
    previous.source.removeInstance(member);
    previous.members.delete(member);
    (member as unknown as { _sourceMesh: Mesh })._sourceMesh = next.source;
    next.source.addInstance(member);
    next.members.add(member);
    this.memberGroups.set(member, next);
    member._syncSubMeshes();
    this.rekeys += 1;
    this.emptied(previous);
    markSceneReadinessDirty(this.scene);
  }

  /** The group source drawing `member`, or undefined for a mesh outside the pool. */
  sourceOf(member: InstancedMesh): Mesh | undefined {
    return this.memberGroups.get(member)?.source;
  }

  /** `member`'s group key, or undefined for a mesh outside the pool. */
  keyOf(member: InstancedMesh): InstanceGroupKey | undefined {
    return this.memberGroups.get(member)?.key;
  }

  /** Re-keys `member` with `change` applied to its key (`rekey`). */
  update(member: InstancedMesh, change: Partial<Omit<InstanceGroupKey, "geometry">>): void {
    const key = this.memberGroups.get(member)?.key;
    if (!key) throw new Error(`"${member.name}" is not a member of the instance pool`);
    this.rekey(member, { ...key, ...change });
  }

  /**
   * Replaces `member` with a mesh of its own (the group's geometry, Material, receiving and rendering group) in its
   * place: same name, parent, transform, visibility, picking and metadata. For what a group cannot draw (a deformer, a
   * blended or World Position Offset Material); the caller refreshes what keyed the member (`onVisualChanged`).
   */
  eject(member: InstancedMesh): Mesh {
    const group = this.memberGroups.get(member);
    if (!group) throw new Error(`"${member.name}" is not a member of the instance pool`);
    const { key } = group;
    const mesh = key.geometry.build(this.scene, member.name);
    mesh.setEnabled(true);
    mesh.material = key.material;
    mesh.receiveShadows = key.receiveShadows;
    mesh.renderingGroupId = key.renderingGroupId;
    mesh.parent = member.parent;
    mesh.position.copyFrom(member.position);
    if (member.rotationQuaternion) mesh.rotationQuaternion = member.rotationQuaternion.clone();
    else mesh.rotation.copyFrom(member.rotation);
    mesh.scaling.copyFrom(member.scaling);
    mesh.isVisible = member.isVisible;
    mesh.isPickable = member.isPickable;
    mesh.layerMask = member.layerMask;
    mesh.metadata = member.metadata;
    member.dispose();
    return mesh;
  }

  /** Counts a mesh the routing left unpooled for `reason`. */
  noteUnpooled(reason: InstancingIneligibility): void {
    this.unpooled[reason] = (this.unpooled[reason] ?? 0) + 1;
  }

  /** Disposes the empty groups kept for a respawn: a new world load's, before its meshes arrive. */
  releaseRetained(): void {
    for (const group of [...this.retained.values()]) this.dispose(group);
  }

  diagnostics(): InstancePoolDiagnostics {
    let pooled = 0;
    let groups = 0;
    for (const group of this.groups.values()) {
      if (!group.members.size) continue;
      groups += 1;
      pooled += group.members.size;
    }
    return { groups, retained: this.retained.size, pooled, rekeys: this.rekeys, unpooled: { ...this.unpooled } };
  }

  dispose(): void;
  dispose(group: InstanceGroup): void;
  dispose(group?: InstanceGroup): void {
    if (!group) {
      for (const each of [...this.groups.values()]) this.dispose(each);
      return;
    }
    this.groups.delete(group.id);
    this.retained.delete(group.id);
    const release = group.release;
    group.release = undefined;
    if (!group.source.isDisposed()) group.source.dispose(false, false);
    release?.();
  }

  private group(key: InstanceGroupKey): InstanceGroup {
    const id = groupId(key);
    const existing = this.groups.get(id);
    if (existing) {
      this.retained.delete(id);
      return existing;
    }
    const source = key.geometry.build(this.scene, `instanceSource:${key.geometry.key}#${++this.sourceCount}`);
    configureSource(source, key);
    sources.add(source);
    const group: InstanceGroup = { id, key, source, members: new Set(), drawn: false, release: undefined };
    group.release = key.geometry.retain?.();
    this.groups.set(id, group);
    return group;
  }

  private left(member: InstancedMesh): void {
    const group = this.memberGroups.get(member);
    if (!group) return;
    if (hasDrawn(member)) group.drawn = true;
    this.memberGroups.delete(member);
    group.members.delete(member);
    this.emptied(group);
  }

  /** An empty group that drew is kept for a respawn (within `RETAINED_EMPTY_GROUPS`); one that never drew goes. */
  private emptied(group: InstanceGroup): void {
    if (group.members.size || !this.groups.has(group.id)) return;
    if (!group.drawn) {
      this.dispose(group);
      return;
    }
    this.retained.delete(group.id);
    this.retained.set(group.id, group);
    while (this.retained.size > RETAINED_EMPTY_GROUPS) this.dispose(this.retained.values().next().value!);
  }
}

/**
 * A group's source: hidden and unpickable (its members draw and pick), at identity with its world matrix frozen (the
 * instance constructor copies the source's transform, and Babylon multiplies nothing by it), drawing its members'
 * normals for any scaling (`NONUNIFORMSCALING`), and never a caster. Its name must not start with `__`, which shadow
 * participation rejects (the controller would then force every member's receiving off).
 */
function configureSource(source: Mesh, key: InstanceGroupKey): void {
  source.material = key.material;
  source.receiveShadows = key.receiveShadows;
  source.renderingGroupId = key.renderingGroupId;
  source.isVisible = false;
  source.isPickable = false;
  source.parent = null;
  source.position.setAll(0);
  source.rotationQuaternion = null;
  source.rotation.setAll(0);
  source.scaling.setAll(1);
  source.freezeWorldMatrix();
  // After the freeze, which found a uniform scale: a frozen world matrix never updates it again.
  (source as unknown as { _updateNonUniformScalingState(value: boolean): boolean })._updateNonUniformScalingState(true);
  const participation: SourceShadowParticipation = { castShadows: false, receiveShadows: key.receiveShadows };
  source.metadata = { ...(source.metadata as object | null), slateShadowParticipation: participation, hapticInstanceSource: true };
  markInstanceSource(source);
}

const pools = new WeakMap<Scene, SceneInstancePool>();
const instancing = new WeakSet<Scene>();

/** Turns automatic instancing on or off for visuals built in `scene` from now on (off by default). */
export function setSceneInstancing(scene: Scene, enabled: boolean): void {
  if (enabled) instancing.add(scene);
  else instancing.delete(scene);
}

/** Whether visuals built in `scene` draw through its instance pool (`setSceneInstancing`). */
export function sceneInstancing(scene: Scene): boolean {
  return instancing.has(scene);
}

/** The pool member `mesh` is, if it is one. */
function poolMember(mesh: AbstractMesh): { pool: SceneInstancePool; member: InstancedMesh } | undefined {
  if (!(mesh instanceof InstancedMesh) || !isInstancePoolSource(mesh.sourceMesh)) return undefined;
  const pool = pools.get(mesh.getScene());
  return pool?.keyOf(mesh) ? { pool, member: mesh } : undefined;
}

/**
 * Sets whether `mesh` receives shadows: a pool member by moving it to the group that does (its own setter warns and
 * does nothing), any other mesh directly.
 */
export function setMeshReceivesShadows(mesh: AbstractMesh, receives: boolean): void {
  const pooled = poolMember(mesh);
  if (pooled) pooled.pool.update(pooled.member, { receiveShadows: receives });
  else mesh.receiveShadows = receives;
}

/** Sets `mesh`'s rendering group: a pool member by moving it to the group drawn in it, any other mesh directly. */
export function setMeshRenderingGroup(mesh: AbstractMesh, renderingGroupId: number): void {
  const pooled = poolMember(mesh);
  if (pooled) pooled.pool.update(pooled.member, { renderingGroupId });
  else mesh.renderingGroupId = renderingGroupId;
}

/** `scene`'s instance pool, created on first use and disposed with the Scene. */
export function sceneInstancePool(scene: Scene): SceneInstancePool {
  let pool = pools.get(scene);
  if (!pool) {
    const created = pool = new SceneInstancePool(scene);
    pools.set(scene, created);
    scene.onDisposeObservable.addOnce(() => {
      pools.delete(scene);
      created.dispose();
    });
  }
  return pool;
}

