import { afterEach, describe, expect, it } from "vitest";
import type { PaletteNode, SerializedPin } from "./graph-types";
import {
  CONNECT_END_CANCEL_PX,
  collectSafeConnectPins,
  containerPointerToClient,
  displayNodeTitle,
  edgesAfterConnect,
  edgesTouchingNodes,
  edgesTouchingPin,
  edgeTouchesNode,
  edgeTouchesPin,
  filterPaletteForPin,
  isClientPointOverGraphNode,
  isClientPointOverHandle,
  isNearSourcePin,
  nodePinLists,
  pinAllowsMultipleIncoming,
  pinsAreCompatible,
  screenCentersForSafePins,
  connectEndAction,
  shouldBreakPinConnectionsOnConnectEnd,
  shouldOpenAddNodeOnConnectEnd,
  connectEventPointerId,
  shouldOpenAddNodeOnSecondaryPointer,
} from "./graph-connect";

const execOut: SerializedPin = {
  id: "execOut",
  name: "then",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const execIn: SerializedPin = {
  id: "execIn",
  name: "exec",
  kind: "exec",
  direction: "in",
  type: { kind: "exec" },
};

const stringOut: SerializedPin = {
  id: "value",
  name: "value",
  kind: "data",
  direction: "out",
  type: { kind: "string" },
};

const stringIn: SerializedPin = {
  id: "message",
  name: "message",
  kind: "data",
  direction: "in",
  type: { kind: "string" },
};

const floatIn: SerializedPin = {
  id: "a",
  name: "a",
  kind: "data",
  direction: "in",
  type: { kind: "float" },
};

describe("displayNodeTitle", () => {
  it("keeps an explicit title", () => {
    expect(displayNodeTitle("flow.event.beginPlay", "Event Begin Play")).toBe(
      "Event Begin Play",
    );
  });

  it("formats flow.event types as Event … instead of flow event …", () => {
    expect(displayNodeTitle("flow.event.beginPlay")).toBe("Event Begin Play");
    expect(displayNodeTitle("flow.event.tick")).toBe("Event Tick");
    expect(displayNodeTitle("flow.event.custom")).toBe("Event Custom");
    expect(displayNodeTitle("flow.event.camera2D")).toBe("Event Camera 2D");
  });

  it("does not Event-prefix Call Custom Event titles", () => {
    expect(displayNodeTitle("flow.event.call", "Call Test")).toBe("Call Test");
    expect(displayNodeTitle("flow.event.call", "Call Event Test")).toBe(
      "Call Event Test",
    );
    expect(displayNodeTitle("flow.event.call")).toBe("Call Custom Event");
  });
});

describe("pinsAreCompatible", () => {
  it("connects exec out to exec in", () => {
    expect(pinsAreCompatible(execOut, execIn)).toBe(true);
  });

  it("rejects same-direction or mismatched kinds", () => {
    expect(pinsAreCompatible(execOut, execOut)).toBe(false);
    expect(pinsAreCompatible(execOut, stringIn)).toBe(false);
    expect(pinsAreCompatible(stringOut, floatIn)).toBe(false);
  });

  it("connects matching data types", () => {
    expect(pinsAreCompatible(stringOut, stringIn)).toBe(true);
  });

  it("uses a host rule so unrelated object class ids do not connect", () => {
    const heroOut: SerializedPin = {
      id: "value",
      name: "value",
      kind: "data",
      direction: "out",
      type: { kind: "objectRef", classId: "Hero" },
    };
    const pawnIn: SerializedPin = {
      id: "target",
      name: "target",
      kind: "data",
      direction: "in",
      type: { kind: "objectRef", classId: "Pawn" },
    };
    expect(pinsAreCompatible(heroOut, pawnIn)).toBe(true);
    expect(
      pinsAreCompatible(heroOut, pawnIn, (outgoing, incoming) => {
        return (
          outgoing.type.kind === incoming.type.kind &&
          "classId" in outgoing.type &&
          "classId" in incoming.type &&
          outgoing.type.classId === incoming.type.classId
        );
      }),
    ).toBe(false);
  });
});

describe("filterPaletteForPin", () => {
  const log: PaletteNode = {
    id: "debug.log",
    title: "Log",
    category: "Debug",
    pins: [execIn, execOut, stringIn],
  };
  const begin: PaletteNode = {
    id: "flow.event.beginPlay",
    title: "Event Begin Play",
    category: "Flow",
    pins: [execOut],
  };

  it("keeps nodes that expose a compatible opposite pin", () => {
    expect(filterPaletteForPin([log, begin], execOut).map((n) => n.id)).toEqual([
      "debug.log",
    ]);
    expect(filterPaletteForPin([log, begin], stringOut).map((n) => n.id)).toEqual(
      ["debug.log"],
    );
  });
});

describe("isNearSourcePin", () => {
  it("cancels when the drop is close to the source pin", () => {
    expect(
      isNearSourcePin({ x: 10, y: 10 }, { x: 12, y: 11 }, CONNECT_END_CANCEL_PX),
    ).toBe(true);
    expect(
      isNearSourcePin({ x: 10, y: 10 }, { x: 200, y: 80 }, CONNECT_END_CANCEL_PX),
    ).toBe(false);
  });
});

describe("CONNECT_END_CANCEL_PX", () => {
  it("is 96 screen pixels so a short slip off a pin does not open Add Node", () => {
    expect(CONNECT_END_CANCEL_PX).toBe(96);
  });
});

describe("collectSafeConnectPins", () => {
  const nodes = [
    { id: "source", pins: [execOut, stringOut] },
    { id: "log", pins: [execIn, execOut, stringIn, floatIn] },
  ];

  it("includes the dragged source pin and compatible opposite pins", () => {
    expect(collectSafeConnectPins(nodes, "source", execOut)).toEqual([
      { nodeId: "source", pinId: "execOut" },
      { nodeId: "log", pinId: "execIn" },
    ]);
  });

  it("excludes incompatible pins", () => {
    const refs = collectSafeConnectPins(nodes, "source", stringOut);
    expect(refs).toEqual([
      { nodeId: "source", pinId: "value" },
      { nodeId: "log", pinId: "message" },
    ]);
    expect(refs.some((ref) => ref.pinId === "a")).toBe(false);
    expect(refs.some((ref) => ref.pinId === "execIn")).toBe(false);
  });
});

describe("shouldOpenAddNodeOnConnectEnd", () => {
  const source = { x: 0, y: 0 };

  it("cancels when the pointer is near the source pin", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointer: { x: 40, y: 0 },
        safePins: [source],
      }),
    ).toBe(false);
  });

  it("opens Add Node when the pointer is far from every safe pin", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointer: { x: 200, y: 0 },
        safePins: [source],
      }),
    ).toBe(true);
  });

  it("cancels when the pointer is near a compatible pin even if far from the source", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointer: { x: 250, y: 0 },
        safePins: [source, { x: 200, y: 0 }],
      }),
    ).toBe(false);
  });

  it("opens Add Node when the pointer is near an incompatible pin only", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointer: { x: 200, y: 0 },
        safePins: [source],
      }),
    ).toBe(true);
  });

  it("cancels when React Flow already snapped to a target handle", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: true,
        pointerOverNode: false,
        pointer: { x: 200, y: 0 },
        safePins: [source],
      }),
    ).toBe(false);
  });

  it("cancels when the pointer is over a node body", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: true,
        pointer: { x: 200, y: 0 },
        safePins: [source],
      }),
    ).toBe(false);
  });

  it("cancels strictly inside the threshold and opens at the boundary", () => {
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointer: { x: 95, y: 0 },
        safePins: [source],
      }),
    ).toBe(false);
    expect(
      shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointer: { x: 96, y: 0 },
        safePins: [source],
      }),
    ).toBe(true);
  });
});

describe("edgeTouchesPin", () => {
  const wired = {
    id: "e:begin:execOut:log:execIn",
    source: "begin",
    target: "log",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };

  it("matches the source pin and the target pin", () => {
    expect(edgeTouchesPin(wired, "begin", "execOut")).toBe(true);
    expect(edgeTouchesPin(wired, "log", "execIn")).toBe(true);
  });

  it("rejects other nodes or handles", () => {
    expect(edgeTouchesPin(wired, "begin", "execIn")).toBe(false);
    expect(edgeTouchesPin(wired, "other", "execOut")).toBe(false);
  });
});

describe("edgesTouchingPin", () => {
  const exec = {
    id: "e:begin:execOut:log:execIn",
    source: "begin",
    target: "log",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };
  const data = {
    id: "e:begin:value:log:message",
    source: "begin",
    target: "log",
    sourceHandle: "value",
    targetHandle: "message",
  };
  const fanOut = {
    id: "e:begin:execOut:print:execIn",
    source: "begin",
    target: "print",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };

  it("returns every incident edge on a fan-out pin", () => {
    expect(edgesTouchingPin([exec, data, fanOut], "begin", "execOut")).toEqual([
      exec,
      fanOut,
    ]);
  });

  it("returns an empty list when the pin has no wires", () => {
    expect(edgesTouchingPin([exec], "begin", "value")).toEqual([]);
  });
});

describe("edgeTouchesNode", () => {
  const exec = {
    id: "e:begin:execOut:log:execIn",
    source: "begin",
    target: "log",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };

  it("is true when the node is the source or the target", () => {
    expect(edgeTouchesNode(exec, "begin")).toBe(true);
    expect(edgeTouchesNode(exec, "log")).toBe(true);
  });

  it("is false when the node is neither endpoint", () => {
    expect(edgeTouchesNode(exec, "print")).toBe(false);
  });
});

describe("edgesTouchingNodes", () => {
  const exec = {
    id: "e:begin:execOut:log:execIn",
    source: "begin",
    target: "log",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };
  const data = {
    id: "e:begin:value:log:message",
    source: "begin",
    target: "log",
    sourceHandle: "value",
    targetHandle: "message",
  };
  const fanOut = {
    id: "e:begin:execOut:print:execIn",
    source: "begin",
    target: "print",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };
  const neighbor = {
    id: "e:log:execOut:print:execIn",
    source: "log",
    target: "print",
    sourceHandle: "execOut",
    targetHandle: "execIn",
  };

  it("returns every incident edge on a fan-out node", () => {
    expect(
      edgesTouchingNodes([exec, data, fanOut, neighbor], new Set(["begin"])),
    ).toEqual([exec, data, fanOut]);
  });

  it("returns the internal edge between two selected nodes", () => {
    expect(
      edgesTouchingNodes([exec, fanOut], new Set(["begin", "log"])),
    ).toEqual([exec, fanOut]);
  });

  it("keeps a neighbor wire when only one endpoint is selected", () => {
    expect(edgesTouchingNodes([exec, neighbor], new Set(["begin"]))).toEqual([
      exec,
    ]);
  });

  it("returns an empty list for an empty selection", () => {
    expect(edgesTouchingNodes([exec, data, fanOut], new Set())).toEqual([]);
  });
});

describe("shouldBreakPinConnectionsOnConnectEnd", () => {
  const source = { x: 0, y: 0 };
  const far = { x: 200, y: 0 };
  const near = { x: 40, y: 0 };

  it("does not break when React Flow snapped to a target handle", () => {
    expect(
      shouldBreakPinConnectionsOnConnectEnd({
        hasTargetHandle: true,
        pointerOverNode: false,
        pointerOverSourceHandle: false,
        pointer: far,
        safePins: [source],
      }),
    ).toBe(false);
  });

  it("does not break when the pointer is still over the source handle", () => {
    expect(
      shouldBreakPinConnectionsOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: true,
        pointerOverSourceHandle: true,
        pointer: { x: 0, y: 0 },
        safePins: [source],
      }),
    ).toBe(false);
  });

  it("does not break when Add Node should open", () => {
    expect(
      shouldBreakPinConnectionsOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointerOverSourceHandle: false,
        pointer: far,
        safePins: [source],
      }),
    ).toBe(false);
  });

  it("breaks in the source-pin safe zone after leaving the handle", () => {
    expect(
      shouldBreakPinConnectionsOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointerOverSourceHandle: false,
        pointer: near,
        safePins: [source],
      }),
    ).toBe(true);
  });

  it("breaks when the pointer is over a node body but not the source handle", () => {
    expect(
      shouldBreakPinConnectionsOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: true,
        pointerOverSourceHandle: false,
        pointer: far,
        safePins: [source],
      }),
    ).toBe(true);
  });

  it("breaks when the pointer is near a compatible pin that did not snap", () => {
    expect(
      shouldBreakPinConnectionsOnConnectEnd({
        hasTargetHandle: false,
        pointerOverNode: false,
        pointerOverSourceHandle: false,
        pointer: { x: 250, y: 0 },
        safePins: [source, { x: 200, y: 0 }],
      }),
    ).toBe(true);
  });
});

function mockRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON() {
        return {};
      },
    }),
  });
}

describe("nodePinLists", () => {
  it("reads __pins from canvas node data", () => {
    expect(
      nodePinLists([
        { id: "a", data: { __pins: [execOut] } },
        { id: "b", data: { message: "no pins" } },
      ]),
    ).toEqual([
      { id: "a", pins: [execOut] },
      { id: "b", pins: undefined },
    ]);
  });
});

describe("screen-space connect helpers", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("returns handle centers for safe pin refs", () => {
    const handle = document.createElement("div");
    handle.className = "react-flow__handle";
    handle.dataset.nodeid = "source";
    handle.dataset.handleid = "execOut";
    mockRect(handle, { left: 10, top: 20, width: 44, height: 44 });
    document.body.append(handle);

    expect(
      screenCentersForSafePins(document, [
        { nodeId: "source", pinId: "execOut" },
      ]),
    ).toEqual([{ x: 32, y: 42 }]);
  });

  it("detects a client point over a graph node body", () => {
    const node = document.createElement("div");
    node.className = "react-flow__node";
    mockRect(node, { left: 100, top: 100, width: 180, height: 80 });
    document.body.append(node);

    expect(isClientPointOverGraphNode({ x: 120, y: 110 }, document)).toBe(true);
    expect(isClientPointOverGraphNode({ x: 10, y: 10 }, document)).toBe(false);
  });

  it("converts a container-relative pointer to client coordinates", () => {
    const pane = document.createElement("div");
    mockRect(pane, { left: 50, top: 80, width: 400, height: 300 });
    expect(containerPointerToClient({ x: 10, y: 20 }, pane)).toEqual({
      x: 60,
      y: 100,
    });
  });

  it("detects a client point over a specific pin handle", () => {
    const handle = document.createElement("div");
    handle.className = "react-flow__handle";
    handle.dataset.nodeid = "source";
    handle.dataset.handleid = "execOut";
    mockRect(handle, { left: 10, top: 20, width: 44, height: 44 });
    document.body.append(handle);

    const other = document.createElement("div");
    other.className = "react-flow__handle";
    other.dataset.nodeid = "log";
    other.dataset.handleid = "execIn";
    mockRect(other, { left: 200, top: 20, width: 44, height: 44 });
    document.body.append(other);

    expect(
      isClientPointOverHandle({ x: 32, y: 42 }, "source", "execOut", document),
    ).toBe(true);
    expect(
      isClientPointOverHandle({ x: 32, y: 42 }, "log", "execIn", document),
    ).toBe(false);
    expect(
      isClientPointOverHandle({ x: 10, y: 10 }, "source", "execOut", document),
    ).toBe(false);
  });
});

describe("connectEndAction", () => {
  const far = {
    hasTargetHandle: false,
    pointerOverNode: false,
    pointerOverSourceHandle: false,
    pointer: { x: 200, y: 0 },
    safePins: [{ x: 0, y: 0 }],
  };
  const near = {
    ...far,
    pointer: { x: 40, y: 0 },
  };

  it("does not open Add Node on default connect-end; near drags break wires", () => {
    expect(connectEndAction(far)).toBe("none");
    expect(connectEndAction(near)).toBe("break");
  });

  it("opens Add Node from a short drag in add-node mode and never breaks wires", () => {
    expect(connectEndAction(near, "add-node")).toBe("add-node");
    expect(connectEndAction(far, "add-node")).toBe("add-node");
    expect(
      connectEndAction({ ...far, pointerOverNode: true }, "add-node"),
    ).toBe("none");
    expect(
      connectEndAction({ ...far, hasTargetHandle: true }, "add-node"),
    ).toBe("none");
  });

  it("disables connect-end side effects", () => {
    expect(connectEndAction(far, "disabled")).toBe("none");
    expect(connectEndAction(near, "disabled")).toBe("none");
  });
});

describe("connectEventPointerId", () => {
  it("reads pointerId from a pointer event", () => {
    const event = new MouseEvent("pointerdown");
    Object.defineProperty(event, "pointerId", { value: 7 });
    expect(connectEventPointerId(event)).toBe(7);
  });

  it("reads the changed touch identifier", () => {
    const event = {
      changedTouches: [{ identifier: 3, clientX: 10, clientY: 20 }],
    };
    expect(connectEventPointerId(event)).toBe(3);
  });

  it("falls back to 1 when the event has no pointer identity", () => {
    expect(connectEventPointerId({})).toBe(1);
    expect(connectEventPointerId({ pointerId: 0 })).toBe(1);
  });
});

describe("shouldOpenAddNodeOnSecondaryPointer", () => {
  const inZone = {
    connectionActive: true,
    dragPointerId: 1,
    eventPointerId: 2,
    inAddNodeZone: true,
  };

  it("opens when a different pointer arrives in the Add Node zone", () => {
    expect(shouldOpenAddNodeOnSecondaryPointer(inZone)).toBe(true);
  });

  it("ignores the drag pointer itself", () => {
    expect(
      shouldOpenAddNodeOnSecondaryPointer({
        ...inZone,
        eventPointerId: 1,
      }),
    ).toBe(false);
  });

  it("ignores a second pointer outside the Add Node zone", () => {
    expect(
      shouldOpenAddNodeOnSecondaryPointer({
        ...inZone,
        inAddNodeZone: false,
      }),
    ).toBe(false);
  });

  it("ignores a second pointer when no connection drag is active", () => {
    expect(
      shouldOpenAddNodeOnSecondaryPointer({
        ...inZone,
        connectionActive: false,
      }),
    ).toBe(false);
  });

  it("ignores a second pointer when the drag pointer id is unknown", () => {
    expect(
      shouldOpenAddNodeOnSecondaryPointer({
        ...inZone,
        dragPointerId: null,
      }),
    ).toBe(false);
  });
});

describe("pinAllowsMultipleIncoming", () => {
  it("allows multiple wires into exec pins", () => {
    expect(pinAllowsMultipleIncoming(execIn)).toBe(true);
    expect(pinAllowsMultipleIncoming(execOut)).toBe(true);
  });

  it("rejects multiple wires into data inputs", () => {
    expect(pinAllowsMultipleIncoming(stringIn)).toBe(false);
  });

  it("does not strip when pin metadata is missing", () => {
    expect(pinAllowsMultipleIncoming(undefined)).toBe(true);
  });
});

describe("edgesAfterConnect", () => {
  const existing = {
    id: "e:root:children:old:parent",
    source: "root",
    target: "old",
    sourceHandle: "children",
    targetHandle: "parent",
  };
  const next = {
    id: "e:sequence:children:old:parent",
    source: "sequence",
    target: "old",
    sourceHandle: "children",
    targetHandle: "parent",
  };
  const unknownPin = () => undefined;

  it("appends a second incoming edge by default", () => {
    const edges = edgesAfterConnect([existing], next, unknownPin);
    expect(edges).toHaveLength(2);
    expect(edges[1]?.source).toBe("sequence");
  });

  it("replaces the existing incoming edge on the same target handle", () => {
    const edges = edgesAfterConnect([existing], next, unknownPin, {
      replaceIncoming: true,
    });
    expect(edges).toEqual([next]);
  });

  const pins = new Map<string, SerializedPin>([
    ["src-a:value", stringOut],
    ["src-b:value", { ...stringOut, id: "value" }],
    ["log:message", stringIn],
    ["log-b:message", { ...stringIn, id: "message" }],
    ["a:execOut", execOut],
    ["b:execOut", { ...execOut, id: "execOut" }],
    ["b:execIn", execIn],
    ["c:execIn", { ...execIn, id: "execIn" }],
  ]);

  function pinFor(nodeId: string, pinId: string): SerializedPin | undefined {
    return pins.get(`${nodeId}:${pinId}`);
  }

  it("keeps exec fan-out from one output to two inputs", () => {
    const existingExec = [
      {
        id: "e:a:execOut:b:execIn",
        source: "a",
        target: "b",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
    ];
    const connected = edgesAfterConnect(
      existingExec,
      {
        id: "e:a:execOut:c:execIn",
        source: "a",
        target: "c",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
      pinFor,
    );
    expect(connected).toHaveLength(2);
  });

  it("keeps exec fan-in from two outputs onto one input", () => {
    const existingExec = [
      {
        id: "e:a:execOut:c:execIn",
        source: "a",
        target: "c",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
    ];
    const connected = edgesAfterConnect(
      existingExec,
      {
        id: "e:b:execOut:c:execIn",
        source: "b",
        target: "c",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
      pinFor,
    );
    expect(connected).toHaveLength(2);
  });

  it("replaces an existing data wire on the same input", () => {
    const existingData = [
      {
        id: "e:src-a:value:log:message",
        source: "src-a",
        target: "log",
        sourceHandle: "value",
        targetHandle: "message",
      },
    ];
    const connected = edgesAfterConnect(
      existingData,
      {
        id: "e:src-b:value:log:message",
        source: "src-b",
        target: "log",
        sourceHandle: "value",
        targetHandle: "message",
      },
      pinFor,
    );
    expect(connected).toEqual([
      {
        id: "e:src-b:value:log:message",
        source: "src-b",
        target: "log",
        sourceHandle: "value",
        targetHandle: "message",
      },
    ]);
  });

  it("keeps data fan-out from one output to two inputs", () => {
    const existingData = [
      {
        id: "e:src-a:value:log:message",
        source: "src-a",
        target: "log",
        sourceHandle: "value",
        targetHandle: "message",
      },
    ];
    const connected = edgesAfterConnect(
      existingData,
      {
        id: "e:src-a:value:log-b:message",
        source: "src-a",
        target: "log-b",
        sourceHandle: "value",
        targetHandle: "message",
      },
      pinFor,
    );
    expect(connected).toHaveLength(2);
  });

  it("does not strip existing wires when the target pin is unknown", () => {
    const existingUnknown = [
      {
        id: "e:mystery:out:unknown:in",
        source: "mystery",
        target: "unknown",
        sourceHandle: "out",
        targetHandle: "in",
      },
    ];
    const connected = edgesAfterConnect(
      existingUnknown,
      {
        id: "e:other:out:unknown:in",
        source: "other",
        target: "unknown",
        sourceHandle: "out",
        targetHandle: "in",
      },
      pinFor,
    );
    expect(connected).toHaveLength(2);
  });

  it("is a no-op when the same edge id already exists", () => {
    const existingData = [
      {
        id: "e:src-a:value:log:message",
        source: "src-a",
        target: "log",
        sourceHandle: "value",
        targetHandle: "message",
      },
    ];
    const connected = edgesAfterConnect(existingData, existingData[0]!, pinFor);
    expect(connected).toEqual(existingData);
  });
});
