import { identitySerializedTransform, type SerializedComponent, type SerializedTransform } from "./scene";

/**
 * A component's local transforms from itself up its attachment chain to the actor origin, child first, so the view
 * composes the actor's world once. Stops at a cycle or a parent that is not among the actor's components.
 */
export function componentAttachmentTransforms(
  component: SerializedComponent,
  byId: ReadonlyMap<string, SerializedComponent>,
): { transforms: SerializedTransform[]; error?: "cyclic" | "missing" } {
  const transforms: SerializedTransform[] = [];
  const visited = new Set<string>();
  let current: SerializedComponent | undefined = component;
  while (current) {
    if (visited.has(current.id)) return { transforms, error: "cyclic" };
    visited.add(current.id);
    transforms.push(current.transform ?? identitySerializedTransform());
    if (current.parentId && !byId.has(current.parentId)) return { transforms, error: "missing" };
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return { transforms };
}
