import { describe, expect, it } from "vitest";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type { Diagnostic } from "@babylonslate/scripting";
import type { SessionReportAsset } from "../lib/session-report-locations";
import {
  documentIdToRevealForDiagnostic,
  navigateToSessionReportEntry,
  sessionReportNavigation,
  type SessionReportNavigationHost,
} from "./diagnostic-navigation";

describe("documentIdToRevealForDiagnostic", () => {
  it("returns the graph document id when that tab is already open", () => {
    expect(
      documentIdToRevealForDiagnostic(
        { graphId: "graph:assets/main.class.babasset" },
        ["content-browser", "graph:assets/main.class.babasset", "scene:assets/main.scene.babasset"],
      ),
    ).toBe("graph:assets/main.class.babasset");
  });

  it("returns null when the graph tab is not open", () => {
    expect(
      documentIdToRevealForDiagnostic(
        { graphId: "graph:assets/main.class.babasset" },
        ["content-browser", "scene:assets/main.scene.babasset"],
      ),
    ).toBeNull();
  });
});

const ASSETS: SessionReportAsset[] = [
  { guid: "hero-guid", path: "assets/Hero.class.babasset", name: "Hero", type: "Class" },
  { guid: "patrol-guid", path: "assets/Patrol.bt.babasset", name: "Patrol", type: "BehaviourTree" },
  { guid: "locomotion-guid", path: "assets/Locomotion.animgraph.babasset", name: "Locomotion", type: "AnimationGraph" },
  { guid: "arena-guid", path: "assets/Arena.scene.babasset", name: "Arena", type: "Scene" },
  { guid: "hud-guid", path: "assets/Hud.scenelayer.babasset", name: "Hud", type: "SceneLayer" },
  { guid: "rock-guid", path: "assets/Rock.model.babasset", name: "Rock", type: "Model" },
  { guid: "legacy-guid", path: "assets/Legacy.babasset", name: "Legacy", type: "Retired" },
];

/** Class scripts report their path, trees and physics their guid. */
function findAsset(ref: string): SessionReportAsset | undefined {
  return ASSETS.find((asset) => asset.guid === ref || asset.path === ref);
}

function entry(overrides: Partial<SessionReportEntry>): SessionReportEntry {
  return {
    code: "runtime.uncaught",
    message: "Boom",
    severity: "error",
    frameId: 1,
    count: 1,
    firstFrameId: 1,
    lastFrameId: 1,
    ...overrides,
  };
}

describe("sessionReportNavigation", () => {
  it("opens the behaviour tree asset and focuses btNodeId", () => {
    const nav = sessionReportNavigation(
      { assetGuid: "patrol-guid", btNodeId: "wait", nodeId: "throw-node" },
      findAsset,
    );
    expect(nav.focusedNodeId).toBe("wait");
    expect(nav.document).toEqual({
      kind: "behaviour-tree",
      path: "assets/Patrol.bt.babasset",
      label: "Patrol",
    });
  });

  it("opens the class asset and passes bodyLine for CodeMirror focus", () => {
    const nav = sessionReportNavigation(
      { nodeId: "js", bodyLine: 3, assetGuid: "hero-guid" },
      findAsset,
    );
    expect(nav.focusedNodeId).toBe("js");
    expect(nav.bodyLine).toBe(3);
    expect(nav.document).toEqual({
      kind: "graph",
      path: "assets/Hero.class.babasset",
      label: "Hero",
    });
  });

  // Every source the runtime can name for an entry opens its owning document.
  it.each([
    ["a Class event graph node, reported by path", { assetGuid: "assets/Hero.class.babasset", nodeId: "print" }, "graph"],
    ["a Class function graph node, reported by path", { assetGuid: "assets/Hero.class.babasset", nodeId: "fn-node", graphId: "jump" }, "graph"],
    ["an Execute JavaScript body line", { assetGuid: "assets/Hero.class.babasset", nodeId: "js", bodyLine: 4 }, "graph"],
    ["a Class node in an exported build, reported by guid", { assetGuid: "hero-guid", nodeId: "print" }, "graph"],
    ["a Behaviour Tree node", { assetGuid: "patrol-guid", btNodeId: "task" }, "behaviour-tree"],
    ["an Animation Graph object", { assetGuid: "assets/Locomotion.animgraph.babasset", nodeId: "n", graphId: "animation-object" }, "anim-graph"],
    ["a Scene that failed to load", { assetGuid: "arena-guid", code: "scene.loading.failed" }, "scene"],
    ["a Scene Layer with physics off", { assetGuid: "hud-guid", code: "physics.scene_layer_physics_disabled", severity: "warning" }, "scene-layer"],
    ["a Model without a collision mesh", { assetGuid: "rock-guid", code: "physics.complex_collision_unavailable", severity: "warning" }, "model"],
  ] as const)("opens %s", (_name, fields, kind) => {
    const nav = sessionReportNavigation(entry(fields), findAsset);
    expect(nav.document?.kind).toBe(kind);
    expect(nav.unavailable).toBeUndefined();
  });

  it.each([
    ["names no asset", entry({ code: "bt.missing_tree" })],
    ["names an asset the project no longer has", entry({ assetGuid: "deleted-guid" })],
    ["names an asset type with no editor", entry({ assetGuid: "legacy-guid" })],
  ])("has no source when the entry %s", (_name, noSource) => {
    const nav = sessionReportNavigation(noSource, findAsset);
    expect(nav.document).toBeUndefined();
    expect(nav.unavailable).toBeTruthy();
  });

  it("has no source when resolving the asset throws", () => {
    const nav = sessionReportNavigation(entry({ assetGuid: "hero-guid" }), () => {
      throw new Error("registry closed");
    });
    expect(nav.document).toBeUndefined();
  });
});

function fakeHost(overrides: Partial<SessionReportNavigationHost> = {}) {
  const open = new Set<string>();
  let focus: Diagnostic | null = null;
  const calls: string[] = [];
  const focusedNodes: Array<string | null> = [];
  const host: SessionReportNavigationHost = {
    findAsset,
    currentFocus: () => focus,
    setFocusDiagnostic: (next, scope) => {
      focus = next;
      calls.push(next ? `focus ${next.nodeId} in ${scope}` : "clear focus");
    },
    setFocusedNodeId: (id) => { focusedNodes.push(id); },
    openDocument: async (ref) => {
      calls.push(`open ${ref.kind}:${ref.path}`);
      open.add(`${ref.kind}:${ref.path}`);
    },
    isDocumentOpen: (id) => open.has(id),
    setActiveDocument: (id) => { calls.push(`activate ${id}`); },
    setAnimEditorMode: (id, mode) => { calls.push(`mode ${id} ${mode}`); },
    requestDocumentFocus: (id) => { calls.push(`keyboard ${id}`); },
    log: (line) => { calls.push(`log ${line}`); },
    ...overrides,
  };
  return { host, calls, focusedNodes, open };
}

describe("navigateToSessionReportEntry", () => {
  it("opens the source, focuses the node and moves the keyboard into the document", async () => {
    const { host, calls, focusedNodes } = fakeHost();
    const result = await navigateToSessionReportEntry(
      entry({ assetGuid: "assets/Hero.class.babasset", nodeId: "print" }),
      host,
    );
    expect(result).toEqual({ opened: true });
    expect(focusedNodes).toEqual(["print"]);
    // The focus is set for the destination before the tab exists, so it survives the switch.
    expect(calls.slice(0, 5)).toEqual([
      "focus print in graph:assets/Hero.class.babasset",
      "open graph:assets/Hero.class.babasset",
      "activate graph:assets/Hero.class.babasset",
      "keyboard graph:assets/Hero.class.babasset",
      "log Navigate to node print",
    ]);
  });

  it("says why when the document cannot be opened, and leaves nothing focused", async () => {
    const { host, calls } = fakeHost({
      openDocument: async () => {
        throw new Error("Read-only during Simulation Play");
      },
    });
    const result = await navigateToSessionReportEntry(
      entry({ assetGuid: "arena-guid", code: "scene.loading.failed" }),
      host,
    );
    expect(result).toEqual({
      opened: false,
      message: "Could not open Arena: Read-only during Simulation Play",
    });
    expect(calls).toContain("clear focus");
    expect(calls.some((call) => call.startsWith("activate") || call.startsWith("keyboard"))).toBe(false);
  });

  it("says so when the open ended without a document, as when a Scene prompt is cancelled", async () => {
    const { host } = fakeHost({ openDocument: async () => undefined });
    expect(
      await navigateToSessionReportEntry(entry({ assetGuid: "arena-guid" }), host),
    ).toEqual({ opened: false, message: "Arena was not opened." });
  });

  it("opens nothing for an entry without a source and says why", async () => {
    const { host, calls, focusedNodes } = fakeHost();
    const result = await navigateToSessionReportEntry(
      entry({ code: "bt.missing_tree", nodeId: "throw-node" }),
      host,
    );
    expect(result.opened).toBe(false);
    expect(calls.some((call) => call.startsWith("open") || call.startsWith("activate"))).toBe(false);
    // The node is still marked as the focused one, for graphs that are showing it.
    expect(focusedNodes).toEqual(["throw-node"]);
  });

  it("frames the node again when the same row is chosen after the view moved", async () => {
    const { host, calls } = fakeHost();
    const target = entry({ assetGuid: "hero-guid", nodeId: "print" });
    await navigateToSessionReportEntry(target, host);
    calls.length = 0;
    await navigateToSessionReportEntry(target, host);
    expect(calls.slice(0, 2)).toEqual([
      "clear focus",
      "focus print in graph:assets/Hero.class.babasset",
    ]);
  });

  it("shows the Animation Object for an error from its lifecycle graph", async () => {
    const { host, calls } = fakeHost();
    await navigateToSessionReportEntry(
      entry({ assetGuid: "assets/Locomotion.animgraph.babasset", nodeId: "n", graphId: "animation-object" }),
      host,
    );
    expect(calls).toContain("mode anim-graph:assets/Locomotion.animgraph.babasset animationObject");
  });
});
