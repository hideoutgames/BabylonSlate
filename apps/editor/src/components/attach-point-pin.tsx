import { useMemo } from "react";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { useRegistryState } from "../context/document-context";
import { skeletonAttachPoints } from "../lib/skeleton-attach-points";
import { AttachPointField } from "./attach-point-field";

/** The Bone pins of Attach To Bone and Spawn Particles Attached: a name, typed or picked from any Skeleton. */
export function AttachPointPin({ request }: { request: PinDefaultEditorRequest }) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const groups = useMemo(() => {
    void registryEpoch;
    return skeletonAttachPoints(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  return (
    <div className="min-w-24 max-w-(--graph-pin-default-max-width)">
      <AttachPointField
        id={`${request.nodeId}:${request.pin.id}`}
        label={request.pin.name}
        value={typeof request.value === "string" ? request.value : ""}
        groups={groups}
        disabled={request.disabled}
        hideLabel
        onChange={(name) => {
          if (!request.disabled) request.onChange(name);
        }}
        data-testid={`attach-point-pin-${request.nodeId}`}
      />
    </div>
  );
}

/** Whether a pin names a bone or socket of the actor it attaches to. */
// eslint-disable-next-line react-refresh/only-export-components -- the dispatch check lives with its editor
export function isAttachPointPin(nodeType: string | undefined, pinId: string): boolean {
  return (nodeType === "actor.attachToBone" && pinId === "boneName") || (nodeType === "particles.spawnAttached" && pinId === "bone");
}
