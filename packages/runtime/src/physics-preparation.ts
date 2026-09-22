import {
  colliderLocalPose,
  multiplyQuat,
  rotateQuatVec,
  scaleColliderShape,
  prepareColliderShape,
  type ColliderLocalTransform,
  type ColliderShape,
  type Quat,
  type Vec3,
} from "@babylonslate/physics";

export function sameDescriptor(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
  return !!a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export function transformDescriptor(local: ColliderLocalTransform): readonly number[] {
  return [local.position.x, local.position.y, local.position.z,
    local.rotation.x, local.rotation.y, local.rotation.z, local.rotation.w,
    local.scale.x, local.scale.y, local.scale.z];
}

/** Each prepared component owns these stages; pose/tuning edits borrow its geometry. */
export class PreparedColliderGeometry {
  private stages: Array<{ source: ColliderShape; scale: Vec3; shape: ColliderShape }> = [];

  private scaled(stage: number, source: ColliderShape, scale: Vec3): ColliderShape {
    const previous = this.stages[stage];
    if (previous?.source === source && previous.scale.x === scale.x && previous.scale.y === scale.y && previous.scale.z === scale.z) return previous.shape;
    const shape = prepareColliderShape(scaleColliderShape(source, scale));
    this.stages[stage] = { source, scale: { ...scale }, shape };
    return shape;
  }

  prepare(source: ColliderShape, local: ColliderLocalTransform, actorScale: Vec3): { shape: ColliderShape; translation: Vec3; rotation: Quat } {
    const pose = colliderLocalPose(source.kind, local, actorScale);
    return { shape: this.scaled(0, source, pose.scale), translation: pose.translation, rotation: pose.rotation };
  }

  prepareImported(source: ColliderShape, imported: ColliderLocalTransform, component: ColliderLocalTransform, actorScale: Vec3): { shape: ColliderShape; translation: Vec3; rotation: Quat } {
    const first = colliderLocalPose(source.kind, imported, component.scale);
    const shape = this.scaled(0, source, first.scale);
    const offset = rotateQuatVec(component.rotation, first.translation);
    const second = colliderLocalPose(shape.kind, {
      position: { x: component.position.x + offset.x, y: component.position.y + offset.y, z: component.position.z + offset.z },
      rotation: multiplyQuat(component.rotation, first.rotation), scale: { x: 1, y: 1, z: 1 },
    }, actorScale);
    return { shape: this.scaled(1, shape, second.scale), translation: second.translation, rotation: second.rotation };
  }
}
