import {
  getBezierPath,
  useStore,
  type ConnectionLineComponentProps,
  type Position,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import { Badge } from "@babylonslate/ui/components/badge";
import {
  collectSafeConnectPins,
  containerPointerToClient,
  isClientPointOverGraphNode,
  nodePinLists,
  screenCentersForSafePins,
  shouldOpenAddNodeOnConnectEnd,
} from "./graph-connect";
import { hasSerializedPins } from "./graph-types";
import { edgeStyleForPin } from "./node-theme";

export type GraphConnectionLineViewProps = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromPosition: Position;
  toPosition: Position;
  connectionLineStyle?: CSSProperties;
  fromNode: { id: string; data: Record<string, unknown> };
  fromHandle: { id?: string | null };
  toHandle: { id?: string | null } | null;
  pointer: { x: number; y: number };
  nodes: Array<{ id: string; data?: Record<string, unknown> }>;
  root?: ParentNode;
};

function pinOnDraggedNode(
  node: { data: Record<string, unknown> },
  pinId: string | null | undefined,
) {
  if (!pinId || !hasSerializedPins(node.data)) return undefined;
  return node.data.__pins.find((pin) => pin.id === pinId);
}

function hintOffset(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): { x: number; y: number } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: toX + (dx / len) * 14 + (-dy / len) * 10,
    y: toY + (dy / len) * 14 + (dx / len) * 10,
  };
}

export function GraphConnectionLineView({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionLineStyle,
  fromNode,
  fromHandle,
  toHandle,
  pointer,
  nodes,
  root = document,
}: GraphConnectionLineViewProps) {
  const pin = pinOnDraggedNode(fromNode, fromHandle.id);
  const pinStyle = edgeStyleForPin(pin?.type);
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const showHint = pin
    ? shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: Boolean(toHandle),
        pointerOverNode: isClientPointOverGraphNode(pointer, root),
        pointer,
        safePins: screenCentersForSafePins(
          root,
          collectSafeConnectPins(nodePinLists(nodes), fromNode.id, pin),
        ),
      })
    : false;
  const badge = hintOffset(fromX, fromY, toX, toY);

  return (
    <>
      <path
        d={path}
        fill="none"
        className="react-flow__connection-path"
        style={{ ...connectionLineStyle, ...pinStyle }}
      />
      {showHint ? (
        <foreignObject
          x={badge.x}
          y={badge.y - 10}
          width={88}
          height={24}
          overflow="visible"
          className="pointer-events-none"
        >
          <Badge
            variant="default"
            data-testid="add-node-hint"
            aria-hidden="true"
            className="pointer-events-none shadow-md"
          >
            Add Node
          </Badge>
        </foreignObject>
      ) : null}
    </>
  );
}

export function GraphConnectionLine(props: ConnectionLineComponentProps) {
  const nodes = useStore((state) => state.nodes);
  const flow = document.querySelector(".react-flow");
  const pointer = flow
    ? containerPointerToClient(props.pointer, flow)
    : props.pointer;
  return (
    <GraphConnectionLineView
      fromX={props.fromX}
      fromY={props.fromY}
      toX={props.toX}
      toY={props.toY}
      fromPosition={props.fromPosition}
      toPosition={props.toPosition}
      connectionLineStyle={props.connectionLineStyle}
      fromNode={props.fromNode}
      fromHandle={props.fromHandle}
      toHandle={props.toHandle}
      pointer={pointer}
      nodes={nodes}
    />
  );
}
