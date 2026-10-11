import {
  getBezierPath,
  useStore,
  type ConnectionLineComponentProps,
  type Position,
} from "@xyflow/react";
import { useMemo, type CSSProperties } from "react";
import { Badge } from "@babylonslate/ui/components/badge";
import {
  collectDisplayConnectPins,
  containerPointerToClient,
  isClientPointOverGraphNode,
  screenCentersForSafePins,
  shouldOpenAddNodeOnConnectEnd,
  type ConnectEndMode,
  type PinCompatibilityRule,
} from "./graph-connect";
import { useGraphEditorContext } from "./graph-editor-context";
import { hasSerializedPins } from "./graph-types";
import { edgeStyleForPin, type PinTypeRef } from "./node-theme";
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
  /** Resolved wildcard types, so the hint matches what a release connects. */
  pinDisplayType?: (nodeId: string, pinId: string) => PinTypeRef | undefined;
  root?: ParentNode;
  connectEndMode?: ConnectEndMode;
  pinCompatibility?: PinCompatibilityRule;
  connectionLineKind?: "default" | "animTransition";
};

function pinOnDraggedNode(
  node: { data: Record<string, unknown> },
  pinId: string | null | undefined,
) {
  if (!pinId || !hasSerializedPins(node.data)) return undefined;
  return node.data.__pins.find((pin) => pin.id === pinId);
}

const declaredType = () => undefined;

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
  pinDisplayType = declaredType,
  root = document,
  connectEndMode = "default",
  pinCompatibility,
  connectionLineKind = "default",
}: GraphConnectionLineViewProps) {
  const declaredPin = pinOnDraggedNode(fromNode, fromHandle.id);
  const pinStyle = edgeStyleForPin(
    declaredPin
      ? (pinDisplayType(fromNode.id, declaredPin.id) ?? declaredPin.type)
      : undefined,
  );
  // Pin compatibility only changes with the graph, not with each pointer move.
  const safeRefs = useMemo(
    () =>
      declaredPin
        ? collectDisplayConnectPins(nodes, fromNode.id, declaredPin, pinDisplayType, pinCompatibility)
        : [],
    [declaredPin, fromNode.id, nodes, pinCompatibility, pinDisplayType],
  );
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
  // Measure the DOM only when the zone decides the hint.
  const showHint = !declaredPin || toHandle
    ? false
    : connectEndMode === "add-node" ||
      (!isClientPointOverGraphNode(pointer, root) &&
        shouldOpenAddNodeOnConnectEnd({
          hasTargetHandle: false,
          pointerOverNode: false,
          pointer,
          safePins: screenCentersForSafePins(root, safeRefs),
        }));
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
  const flow = useStore((state) => state.domNode);
  const { connectEndMode, connectionLineKind, pinCompatibility, pinDisplayType } = useGraphEditorContext();
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
      pinDisplayType={pinDisplayType}
      root={flow ?? document}
      connectEndMode={connectEndMode}
      pinCompatibility={pinCompatibility}
      connectionLineKind={connectionLineKind}
    />
  );
}
