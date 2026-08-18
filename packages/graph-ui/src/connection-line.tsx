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
  type ConnectEndMode,
} from "./graph-connect";
import { useGraphEditorContext } from "./graph-editor-context";
import { hasSerializedPins } from "./graph-types";
import { edgeStyleForPin } from "./node-theme";
import { animTransitionPath } from "./anim-transition-path";

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
  connectEndMode?: ConnectEndMode;
  connectionLineKind?: "default" | "animTransition";
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
  connectEndMode = "default",
  connectionLineKind = "default",
}: GraphConnectionLineViewProps) {
  const pin = pinOnDraggedNode(fromNode, fromHandle.id);
  const pinStyle = edgeStyleForPin(pin?.type);
  const path =
    connectionLineKind === "animTransition"
      ? animTransitionPath({
          sourceX: fromX,
          sourceY: fromY,
          sourcePosition: fromPosition,
          targetX: toX,
          targetY: toY,
          targetPosition: toPosition,
        }).path
      : getBezierPath({
          sourceX: fromX,
          sourceY: fromY,
          sourcePosition: fromPosition,
          targetX: toX,
          targetY: toY,
          targetPosition: toPosition,
        })[0];
  const inAddZone = pin
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
  const showHint = pin
    ? connectEndMode === "disabled"
      ? false
      : connectEndMode === "add-node"
        ? !toHandle
        : inAddZone
    : false;
  const badge = hintOffset(fromX, fromY, toX, toY);
  const hintLabel =
    connectEndMode === "zone-add-node" ? "Release to Add Node" : "Tap to Cancel";

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
          width={180}
          height={24}
          overflow="visible"
          className="pointer-events-none"
        >
          <Badge
            variant="default"
            data-testid="add-node-hint"
            aria-hidden="true"
            className="pointer-events-none whitespace-nowrap shadow-md"
          >
            {hintLabel}
          </Badge>
        </foreignObject>
      ) : null}
    </>
  );
}

export function GraphConnectionLine(props: ConnectionLineComponentProps) {
  const nodes = useStore((state) => state.nodes);
  const { connectEndMode, connectionLineKind } = useGraphEditorContext();
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
      connectEndMode={connectEndMode}
      connectionLineKind={connectionLineKind}
    />
  );
}
