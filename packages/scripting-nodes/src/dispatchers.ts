import {
  delegateOf,
  EXEC,
  objectRef,
  pin,
  pinTypeForVariable,
  type CodegenContext,
  type GraphPin,
  type NodeDefinition,
  type PinType,
} from "@haptic/scripting";
import {
  CALL_PIN_IDS,
  dataMemberPins,
  jsIdent,
  memberPinRows,
  memberTargetPin,
  type MemberPinRow,
} from "./member-pins";
import { selfPin, subject } from "./self-pin";

/** Add Node and Class window category of the Event Dispatcher nodes. */
export const EVENT_DISPATCHER_CATEGORY = "eventDispatchers";

/** Catalog ids of the four nodes bound to one Event Dispatcher member. */
export const DISPATCHER_NODE_TYPE_IDS = {
  call: "flow.dispatcher.call",
  bind: "flow.dispatcher.bind",
  unbind: "flow.dispatcher.unbind",
  unbindAll: "flow.dispatcher.unbindAll",
} as const;

export type DispatcherNodeAction = keyof typeof DISPATCHER_NODE_TYPE_IDS;

export const CREATE_EVENT_NODE_TYPE_ID = "flow.delegate.create";

/** Pin id of a custom event's delegate, drawn in its title bar. */
export const OUTPUT_DELEGATE_PIN_ID = "OutputDelegate";

const DISPATCHER_NODE_IDS: ReadonlySet<string> = new Set(
  Object.values(DISPATCHER_NODE_TYPE_IDS),
);

export function isDispatcherNodeType(typeId: string): boolean {
  return DISPATCHER_NODE_IDS.has(typeId);
}

/** Canvas title of a dispatcher node: `Call On Damaged`, `Bind Event to On Damaged`. */
export function dispatcherNodeTitle(
  action: DispatcherNodeAction,
  dispatcherName: string,
): string {
  switch (action) {
    case "call":
      return `Call ${dispatcherName}`;
    case "bind":
      return `Bind Event to ${dispatcherName}`;
    case "unbind":
      return `Unbind Event from ${dispatcherName}`;
    case "unbindAll":
      return `Unbind All Events from ${dispatcherName}`;
  }
}

/** Data rows of a signature, in order (exec rows never belong to one). */
function signatureRows(properties: Record<string, unknown>): MemberPinRow[] {
  return memberPinRows(properties).filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      typeof row.name === "string" &&
      row.name.length > 0 &&
      row.typeId !== "exec",
  );
}

/** Delegate type taking the inputs listed in a node's `pins` rows. */
export function signatureDelegateType(
  properties: Record<string, unknown>,
): PinType {
  return delegateOf(signatureRows(properties).map((row) => pinTypeForVariable(row)));
}

/** Parameter names a delegate maps a dispatcher's positional arguments onto. */
export function signatureParameterNames(
  properties: Record<string, unknown>,
): string[] {
  return signatureRows(properties).map((row) => row.name!);
}

function stringProperty(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

function dispatcherIdent(properties: Record<string, unknown>): string {
  return jsIdent(stringProperty(properties, "name") || "Dispatcher");
}

function dispatcherClassId(properties: Record<string, unknown>): string {
  return stringProperty(properties, "classId") || "Object";
}

/** 32-bit FNV-1a, hex: names a hoisted constant after its content. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Module-scope frozen array of a delegate's parameter names. A dispatcher
 * passes its values by position; the delegate keys them by these names.
 */
function hoistedParameterNames(ctx: CodegenContext, names: readonly string[]): string {
  const literal = JSON.stringify(names);
  const ident = `__delegateParams_${contentHash(literal)}`;
  ctx.hoist(`const ${ident} = Object.freeze(${literal});`);
  return ident;
}

/**
 * Expression for a delegate that runs `memberName` on `objectExpr`: a custom
 * event (`kind` "event") or a function. The value is cached per object and
 * member, so Unbind finds the one Bind added.
 */
export function eventDelegateExpression(
  ctx: CodegenContext,
  objectExpr: string,
  memberName: string,
  kind: "event" | "function",
  parameterNames: readonly string[],
): string {
  const params = hoistedParameterNames(ctx, parameterNames);
  return `ctx.eventDelegate(${objectExpr}, ${JSON.stringify(jsIdent(memberName))}, ${JSON.stringify(kind)}, ${params})`;
}

function dispatcherTarget(properties: Record<string, unknown>): GraphPin {
  return memberTargetPin(properties, "target", dispatcherClassId(properties));
}

function eventPin(properties: Record<string, unknown>): GraphPin {
  return subject(pin("event", "Event", "in", signatureDelegateType(properties)));
}

function execPins(): GraphPin[] {
  return [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];
}

function bindingNode(
  id: string,
  title: string,
  description: string,
  runtime: "bindDispatcher" | "unbindDispatcher",
): NodeDefinition {
  return {
    id,
    title,
    category: EVENT_DISPATCHER_CATEGORY,
    description,
    pins: (properties) => [...execPins(), dispatcherTarget(properties), eventPin(properties)],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.${runtime}(${ctx.input("target")}, ${JSON.stringify(dispatcherIdent(ctx.node.properties))}, ${ctx.input("event")});`,
      );
    },
  };
}

export const dispatcherNodes: NodeDefinition[] = [
  {
    id: DISPATCHER_NODE_TYPE_IDS.call,
    title: "Call Event Dispatcher",
    category: EVENT_DISPATCHER_CATEGORY,
    description:
      "Runs every event bound to the Event Dispatcher on Target, in the order they were bound, then continues.",
    pins: (properties) => [
      ...execPins(),
      dispatcherTarget(properties),
      ...dataMemberPins(properties, "in", CALL_PIN_IDS),
    ],
    codegen: (ctx) => {
      const values = ctx.node.pins
        .filter(
          (entry) =>
            entry.direction === "in" &&
            entry.kind === "data" &&
            entry.id !== "target",
        )
        .map((entry) => ctx.input(entry.id));
      ctx.emit(
        `ctx.callDispatcher(${ctx.input("target")}, ${JSON.stringify(dispatcherIdent(ctx.node.properties))}, [${values.join(", ")}]);`,
      );
    },
  },
  bindingNode(
    DISPATCHER_NODE_TYPE_IDS.bind,
    "Bind Event to Event Dispatcher",
    "Adds Event to the Event Dispatcher on Target. Binding the same event twice keeps one binding.",
    "bindDispatcher",
  ),
  bindingNode(
    DISPATCHER_NODE_TYPE_IDS.unbind,
    "Unbind Event from Event Dispatcher",
    "Removes Event from the Event Dispatcher on Target.",
    "unbindDispatcher",
  ),
  {
    id: DISPATCHER_NODE_TYPE_IDS.unbindAll,
    title: "Unbind All Events from Event Dispatcher",
    category: EVENT_DISPATCHER_CATEGORY,
    description: "Removes every event bound to the Event Dispatcher on Target.",
    pins: (properties) => [...execPins(), dispatcherTarget(properties)],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.unbindAllDispatcher(${ctx.input("target")}, ${JSON.stringify(dispatcherIdent(ctx.node.properties))});`,
      );
    },
  },
  {
    id: CREATE_EVENT_NODE_TYPE_ID,
    title: "Create Event",
    category: EVENT_DISPATCHER_CATEGORY,
    description:
      "A delegate that runs the chosen custom event or function on Object. Connect it to a Bind or Unbind node.",
    pure: true,
    pins: (properties) => {
      const classId = dispatcherClassId(properties);
      return [
        properties.implicitSelf === false
          ? subject(pin("object", "Object", "in", objectRef(classId)))
          : selfPin("object", "Object", objectRef(classId)),
        pin("event", "Event", "out", signatureDelegateType(properties)),
      ];
    },
    codegen: (ctx) => {
      const memberName = stringProperty(ctx.node.properties, "memberName");
      if (!memberName) return { event: "null" };
      const kind = ctx.node.properties.memberKind === "function" ? "function" : "event";
      return {
        event: eventDelegateExpression(
          ctx,
          ctx.input("object"),
          memberName,
          kind,
          signatureParameterNames(ctx.node.properties),
        ),
      };
    },
  },
];
