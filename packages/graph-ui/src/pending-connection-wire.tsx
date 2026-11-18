import { getBezierPath, Position, useInternalNode, ViewportPortal } from "@xyflow/react";
import type { CSSProperties } from "react";

const OPPOSITE: Record<Position, Position> = {
  [Position.Left]: Position.Right,
  [Position.Right]: Position.Left,
  [Position.Top]: Position.Bottom,
  [Position.Bottom]: Position.Top,
};

/**
 * The wire a release on empty canvas leaves while **Add Node** is open: from its
 * pin to where it was released, drawn like the dragged wire, so the menu reads as
 * finishing that connection. Closing the menu removes it; a picked node replaces
 * it with a real wire.
 */
export function PendingConnectionWire({
  nodeId,
  pinId,
  direction,
  to,
  style,
}: {
  nodeId: string;
  pinId: string;
  direction: "in" | "out";
  /** The release point, in flow coordinates. */
  to: { x: number; y: number };
  style?: CSSProperties;
}) {
  const node = useInternalNode(nodeId);
  const bounds = node?.internals.handleBounds;
  const handle = (direction === "out" ? bounds?.source : bounds?.target)?.find((entry) => entry.id === pinId);
  if (!node || !handle) return null;
  // The pin's centre, where the dragged wire started.
  const fromX = node.internals.positionAbsolute.x + handle.x + handle.width / 2;
  const fromY = node.internals.positionAbsolute.y + handle.y + handle.height / 2;
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: handle.position,
    targetX: to.x,
    targetY: to.y,
    targetPosition: OPPOSITE[handle.position],
  });
  return (
    <ViewportPortal>
      <svg
        aria-hidden="true"
        width="1"
        height="1"
        data-testid="pending-connection-wire"
        style={{ position: "absolute", overflow: "visible", pointerEvents: "none" }}
      >
        <path d={path} fill="none" className="react-flow__connection-path" style={style} />
      </svg>
    </ViewportPortal>
  );
}
