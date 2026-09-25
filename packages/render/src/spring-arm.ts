import {
  Color3,
  Color4,
  Matrix,
  MeshBuilder,
  Quaternion,
  TransformNode,
  Vector3,
  type LinesMesh,
  type Mesh,
  type Node,
  type Scene,
} from "@babylonjs/core";
import {
  springArmSocketPosition,
  stepSpringArmLag,
  type SpringArmPose,
  type SpringArmProperties,
} from "@babylonslate/core";
import { RENDERING_GROUP } from "./sorting";

/** Play part mesh kind the runtime emits for a `SpringArmComponent`. */
export const SPRING_ARM_MESH_KIND = "springarm";
export const SPRING_ARM_DEBUG_PREFIX = "springArmDebug:";
/** Samples kept for each debug socket trail. */
export const SPRING_ARM_DEBUG_TRAIL_POINTS = 48;

const EDITOR_BOOM_COLOR = new Color3(0.92, 0.93, 0.96);
const TARGET_COLOR = new Color4(1, 0.85, 0.2, 1);
const LAGGED_COLOR = new Color4(0.25, 1, 0.45, 1);
const OFFSET_COLOR = new Color4(1, 0.3, 0.25, 1);
const MARKER_SIZE = 0.12;

type SpringArmMetadata = { springArmSocket?: TransformNode };

/** Add the node that children attach to, `armLength` behind the arm pivot. */
export function addSpringArmSocket(arm: Mesh, armLength: number): TransformNode {
  const socket = new TransformNode(`${arm.name}:socket`, arm.getScene());
  socket.parent = arm;
  socket.position.fromArray(springArmSocketPosition(armLength));
  arm.metadata = { ...(arm.metadata ?? {}), springArmSocket: socket };
  return socket;
}

export function springArmSocketOf(node: Node | null | undefined): TransformNode | null {
  const socket = (node?.metadata as SpringArmMetadata | null | undefined)?.springArmSocket;
  return socket && !socket.isDisposed() ? socket : null;
}

/** Children of a spring arm attach at its socket; any other parent is used as is. */
export function attachmentParentFor(parent: TransformNode): TransformNode {
  return springArmSocketOf(parent) ?? parent;
}

function crossLines(center: Vector3): Vector3[][] {
  return [
    [center.add(new Vector3(-MARKER_SIZE, 0, 0)), center.add(new Vector3(MARKER_SIZE, 0, 0))],
    [center.add(new Vector3(0, -MARKER_SIZE, 0)), center.add(new Vector3(0, MARKER_SIZE, 0))],
    [center.add(new Vector3(0, 0, -MARKER_SIZE)), center.add(new Vector3(0, 0, MARKER_SIZE))],
  ];
}

/** Editor visual: pivot marker, the arm line, and a socket marker children attach to. */
export function createEditorSpringArmMesh(scene: Scene, name: string, armLength: number): Mesh {
  const end = Vector3.FromArray(springArmSocketPosition(armLength));
  const mesh = MeshBuilder.CreateLineSystem(
    name,
    { lines: [...crossLines(Vector3.Zero()), [Vector3.Zero(), end], ...crossLines(end)] },
    scene,
  );
  mesh.color = EDITOR_BOOM_COLOR;
  addSpringArmSocket(mesh, armLength);
  return mesh;
}

/** Last lagged arm pivot per `slotId|componentId`, kept across visual rebuilds. */
export type SpringArmLagStore = Map<string, SpringArmPose>;

export interface SpringArmRig {
  key: string;
  arm: Mesh;
  socket: TransformNode;
  properties: SpringArmProperties;
  authored: { position: Vector3; rotation: Quaternion; scaling: Vector3 };
  debug: SpringArmDebugLines | null;
}

const rigsByRoot = new WeakMap<Mesh, SpringArmRig[]>();
const cameraAnchors = new WeakMap<Mesh, Mesh>();

/**
 * Turn a Play part mesh (already posed at its authored local TRS) into a
 * spring arm. The lag writes the arm's local pose every frame; the authored
 * pose is kept as the lag target.
 */
export function createPlaySpringArmRig(
  root: Mesh,
  arm: Mesh,
  key: string,
  properties: SpringArmProperties,
): SpringArmRig {
  const socket = addSpringArmSocket(arm, properties.armLength);
  const rig: SpringArmRig = {
    key,
    arm,
    socket,
    properties,
    authored: {
      position: arm.position.clone(),
      rotation: arm.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(arm.rotation),
      scaling: arm.scaling.clone(),
    },
    debug: properties.drawDebugLag ? new SpringArmDebugLines(arm, key) : null,
  };
  arm.rotationQuaternion = rig.authored.rotation.clone();
  arm.onDisposeObservable.addOnce(() => rig.debug?.dispose());
  const rigs = rigsByRoot.get(root) ?? [];
  rigs.push(rig);
  rigsByRoot.set(root, rigs);
  return rig;
}

export function springArmRigsOf(root: Mesh): readonly SpringArmRig[] {
  return rigsByRoot.get(root) ?? [];
}

/** A slot's camera follows this part mesh instead of the actor pose. */
export function setSpringArmCameraAnchor(root: Mesh, anchor: Mesh): void {
  cameraAnchors.set(root, anchor);
}

export function springArmCameraAnchorOf(root: Mesh): Mesh | null {
  const anchor = cameraAnchors.get(root);
  return anchor && !anchor.isDisposed() ? anchor : null;
}

const scratchLocal = new Matrix();
const scratchTarget = new Matrix();
const scratchLagged = new Matrix();
const scratchInverse = new Matrix();
const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();
const scratchLaggedRotation = new Quaternion();
const scratchLaggedPosition = new Vector3();

function restoreAuthored(rig: SpringArmRig): void {
  rig.arm.position.copyFrom(rig.authored.position);
  rig.arm.rotationQuaternion!.copyFrom(rig.authored.rotation);
  rig.arm.scaling.copyFrom(rig.authored.scaling);
}

/**
 * Move the arm pivot toward its authored world pose and write the lagged pose
 * back as a local transform, so the socket and every child follow it.
 */
export function updateSpringArmRig(rig: SpringArmRig, store: SpringArmLagStore, dtSeconds: number): void {
  const parent = rig.arm.parent as TransformNode | null;
  if (!parent || rig.arm.isDisposed()) return;
  const parentWorld = parent.computeWorldMatrix(true);
  const { properties } = rig;
  if (Math.abs(parentWorld.determinant()) < 1e-12) {
    restoreAuthored(rig);
    return;
  }
  Matrix.ComposeToRef(rig.authored.scaling, rig.authored.rotation, rig.authored.position, scratchLocal);
  scratchLocal.multiplyToRef(parentWorld, scratchTarget);
  if (!scratchTarget.decompose(scratchScale, scratchRotation, scratchPosition)) {
    restoreAuthored(rig);
    return;
  }
  const target: SpringArmPose = {
    position: [scratchPosition.x, scratchPosition.y, scratchPosition.z],
    rotation: [scratchRotation.x, scratchRotation.y, scratchRotation.z, scratchRotation.w],
  };
  const lagged = stepSpringArmLag(store.get(rig.key) ?? null, target, dtSeconds, properties);
  store.set(rig.key, lagged);
  if (!properties.enableLocationLag && !properties.enableRotationLag) {
    restoreAuthored(rig);
    rig.debug?.update(scratchTarget, scratchTarget, properties.armLength);
    return;
  }
  scratchLaggedPosition.fromArray(lagged.position);
  scratchLaggedRotation.set(...lagged.rotation);
  Matrix.ComposeToRef(scratchScale, scratchLaggedRotation, scratchLaggedPosition, scratchLagged);
  parentWorld.invertToRef(scratchInverse);
  scratchLagged.multiplyToRef(scratchInverse, scratchLocal);
  scratchLocal.decompose(rig.arm.scaling, rig.arm.rotationQuaternion!, rig.arm.position);
  rig.debug?.update(scratchTarget, scratchLagged, properties.armLength);
}

/**
 * World-space lines that show the smoothing: the target arm (yellow), the
 * lagged arm (green), the lag offsets between their pivots and sockets (red),
 * and recent socket trails for both.
 */
export class SpringArmDebugLines {
  readonly mesh: LinesMesh;
  private readonly targetTrail: Vector3[] = [];
  private readonly laggedTrail: Vector3[] = [];
  private primed = false;

  constructor(arm: Mesh, key: string) {
    const scene = arm.getScene();
    const lines = this.lines(Vector3.Zero(), Vector3.Zero(), Vector3.Zero(), Vector3.Zero());
    const colors = lines.map((line, index) => line.map(() => {
      if (index === 0 || index === 4 || index === 5 || index === 6 || index === 10) return TARGET_COLOR;
      if (index === 2 || index === 3) return OFFSET_COLOR;
      return LAGGED_COLOR;
    }));
    this.mesh = MeshBuilder.CreateLineSystem(`${SPRING_ARM_DEBUG_PREFIX}${key}`, { lines, colors, updatable: true }, scene);
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.renderingGroupId = RENDERING_GROUP.world;
    this.mesh.metadata = { ...(this.mesh.metadata ?? {}), playDebugOverlay: true };
  }

  update(target: Matrix, lagged: Matrix, armLength: number): void {
    const socketLocal = Vector3.FromArray(springArmSocketPosition(armLength));
    const targetPivot = target.getTranslation();
    const laggedPivot = lagged.getTranslation();
    const targetSocket = Vector3.TransformCoordinates(socketLocal, target);
    const laggedSocket = Vector3.TransformCoordinates(socketLocal, lagged);
    this.push(this.targetTrail, targetSocket);
    this.push(this.laggedTrail, laggedSocket);
    this.primed = true;
    MeshBuilder.CreateLineSystem(this.mesh.name, {
      lines: this.lines(targetPivot, targetSocket, laggedPivot, laggedSocket),
      instance: this.mesh,
    });
  }

  dispose(): void {
    this.mesh.dispose();
  }

  private push(trail: Vector3[], point: Vector3): void {
    if (!this.primed) {
      trail.length = 0;
      for (let i = 0; i < SPRING_ARM_DEBUG_TRAIL_POINTS; i++) trail.push(point.clone());
      return;
    }
    trail.shift();
    trail.push(point.clone());
  }

  private lines(targetPivot: Vector3, targetSocket: Vector3, laggedPivot: Vector3, laggedSocket: Vector3): Vector3[][] {
    const trail = (points: Vector3[]) => points.length === SPRING_ARM_DEBUG_TRAIL_POINTS
      ? points
      : Array.from({ length: SPRING_ARM_DEBUG_TRAIL_POINTS }, () => Vector3.Zero());
    return [
      [targetPivot, targetSocket],
      [laggedPivot, laggedSocket],
      [targetPivot, laggedPivot],
      [targetSocket, laggedSocket],
      ...crossLines(targetSocket),
      ...crossLines(laggedSocket),
      trail(this.targetTrail),
      trail(this.laggedTrail),
    ];
  }
}
