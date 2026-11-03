import { describe, expect, it } from "vitest";
import {
  isDockviewDocumentKind,
  listDockWindows,
  primaryDockPanel,
  resolveDockInitialWidth,
} from "./window-catalog";

describe("resolveDockInitialWidth", () => {
  it("converts a width ratio against the DockView host", () => {
    expect(
      resolveDockInitialWidth(
        {
          referencePanelId: "sprite-animation-preview",
          direction: "right",
          initialWidthRatio: 0.75,
        },
        800,
      ),
    ).toBe(600);
  });

  it("keeps pixel widths when no ratio is set", () => {
    expect(
      resolveDockInitialWidth(
        {
          referencePanelId: "sprite-preview",
          direction: "right",
          initialWidth: 280,
        },
        800,
      ),
    ).toBe(280);
  });

  it("omits a ratio width when the host is unmeasured", () => {
    expect(
      resolveDockInitialWidth(
        {
          referencePanelId: "sprite-animation-preview",
          direction: "right",
          initialWidthRatio: 0.75,
        },
        0,
      ),
    ).toBeUndefined();
  });
});

describe("listDockWindows", () => {
  it("omits Prefab and Components for non-Actor class documents", () => {
    const windows = listDockWindows("graph", { actorPrefab: false });
    expect(windows.map((entry) => entry.id)).toEqual([
      "graph",
      "my-class",
      "inspector",
      "compiler-results",
      "breakpoints",
      "watches",
    ]);
    const classPanel = windows.find((entry) => entry.id === "my-class");
    expect(classPanel?.defaultPosition).toEqual({
      referencePanelId: "graph",
      direction: "left",
      initialWidth: 260,
    });
  });

  it("opens Prefab assets with only Prefab, Components and Inspector", () => {
    const windows = listDockWindows("prefab");
    expect(windows.map((entry) => [entry.id, entry.title])).toEqual([
      ["prefab-viewport", "Prefab"],
      ["actor-prefab", "Components"],
      ["inspector", "Inspector"],
    ]);
    expect(primaryDockPanel("prefab")).toBe("prefab-viewport");
  });

  it("docks Assets below the Outliner in Scene and Scene Layer Design mode only", () => {
    for (const kind of ["scene", "scene-layer"] as const) {
      const assets = listDockWindows(kind, { sceneMode: "design" }).find((entry) => entry.id === "scene-assets");
      expect(assets).toMatchObject({
        component: "scene-assets",
        title: "Assets",
        defaultPosition: { referencePanelId: "scene-outliner", direction: "below" },
      });
      for (const sceneMode of ["script", "timeline"] as const) {
        expect(listDockWindows(kind, { sceneMode }).map((entry) => entry.id)).not.toContain("scene-assets");
      }
    }
    for (const sceneMode of ["landscape", "foliage"] as const) {
      expect(listDockWindows("scene", { sceneMode }).map((entry) => entry.id)).not.toContain("scene-assets");
    }
  });

  it("opens a Tileset on its Preview with Autotiles as a tab beside it and the Inspector on the right", () => {
    const windows = listDockWindows("tileset");
    expect(windows.map((entry) => [entry.id, entry.component, entry.title])).toEqual([
      ["tileset-preview", "tileset-preview", "Preview"],
      ["tileset-autotiles", "tileset-autotiles", "Autotiles"],
      ["tileset-details", "tileset-details", "Inspector"],
    ]);
    expect(windows.find((entry) => entry.id === "tileset-autotiles")).toMatchObject({
      defaultPosition: { referencePanelId: "tileset-preview", direction: "within" },
    });
    expect(windows.every((entry) => entry.openByDefault !== false)).toBe(true);
    expect(primaryDockPanel("tileset")).toBe("tileset-preview");
  });

  it("omits the Locks window when source control is off", () => {
    for (const kind of [
      "scene",
      "graph",
      "enum",
      "structure",
      "script-interface",
      "sprite",
      "sprite-animation",
      "tileset",
      "tilemap",
      "plugin-settings",
      "anim-graph",
      "behaviour-tree",
      "audio-mixer",
      "audio-channel",
      "sound-attenuation",
      "particle-emitter",
      "particle-graph",
      "particle-system",
      "model",
      "skeleton",
      "animation",
      "audio",
      "skybox-creator",
    ] as const) {
      expect(listDockWindows(kind).some((entry) => entry.id === "locks")).toBe(
        false,
      );
    }
  });

  it("appends Locks below each kind's primary panel when source control is on", () => {
    const scene = listDockWindows("scene", { sourceControl: true });
    expect(scene.map((entry) => entry.id)).toContain("locks");
    expect(scene.find((entry) => entry.id === "locks")).toEqual({
      id: "locks",
      component: "locks",
      title: "Locks",
      defaultPosition: {
        referencePanelId: "viewport",
        direction: "below",
        initialHeight: 180,
      },
    });
    expect(
      listDockWindows("graph", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("graph");
    expect(
      listDockWindows("sprite", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("sprite-preview");
    expect(
      listDockWindows("sprite-animation", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("sprite-animation-preview");
  });
});

describe("material dock catalog", () => {
  it("swaps Preview for Interface on a Material Function", () => {
    const ids = listDockWindows("material-function").map((entry) => entry.id);
    expect(ids).toContain("material-function-interface");
    expect(ids).not.toContain("material-preview");
  });

  it("focuses the graph as the primary panel for both material kinds", () => {
    expect(primaryDockPanel("material")).toBe("material-graph");
    expect(primaryDockPanel("material-function")).toBe(
      "material-function-graph",
    );
  });

  it("opens a Material Instance on its Preview with the Inspector beside it", () => {
    expect(listDockWindows("material-instance").map((entry) => entry.title)).toEqual(["Preview", "Inspector"]);
    expect(primaryDockPanel("material-instance")).toBe("material-instance-preview");
  });

  it("opens a Timeline Asset in DockView on its Timeline Clips with Events beside it", () => {
    expect(isDockviewDocumentKind("timeline")).toBe(true);
    expect(listDockWindows("timeline").map((entry) => [entry.id, entry.title])).toEqual([
      ["timeline-asset-clips", "Timeline Clips"],
      ["timeline-asset-events", "Events"],
    ]);
    expect(primaryDockPanel("timeline")).toBe("timeline-asset-clips");
    for (const kind of ["timeline-clip-2d", "timeline-clip-3d"] as const) {
      expect(isDockviewDocumentKind(kind)).toBe(true);
      expect(listDockWindows(kind).map((entry) => [entry.id, entry.title])).toEqual([
        ["timeline-clip-viewport", "Viewport"],
        ["timeline-clip-inspector", "Inspector"],
        ["timeline-clip-proxies", "Proxies"],
        ["timeline-clip-timeline", "Timeline"],
        ["compiler-results", "Compiler Results"],
      ]);
      // Compiler Results opens from the Windows menu.
      expect(listDockWindows(kind).filter((entry) => entry.openByDefault !== false).map((entry) => entry.id)).not.toContain("compiler-results");
      expect(primaryDockPanel(kind)).toBe("timeline-clip-viewport");
    }
  });

  it("opens a Blackboard in DockView on its Keys with the Inspector beside it", () => {
    expect(isDockviewDocumentKind("blackboard")).toBe(true);
    expect(listDockWindows("blackboard").map((entry) => entry.title)).toEqual(["Keys", "Inspector"]);
    expect(primaryDockPanel("blackboard")).toBe("blackboard-keys");
  });

  it("opens a Font in DockView on its Preview with the Inspector beside it", () => {
    expect(isDockviewDocumentKind("font")).toBe(true);
    expect(listDockWindows("font").map((entry) => entry.title)).toEqual(["Preview", "Inspector"]);
    expect(primaryDockPanel("font")).toBe("font-preview");
  });

  it("anchors Locks under the material graph when source control is on", () => {
    expect(
      listDockWindows("material", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("material-graph");
  });
});

describe("particle graph dock catalog", () => {
  it("anchors Locks under the Graph when source control is on", () => {
    expect(
      listDockWindows("particle-graph", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("particle-graph-canvas");
  });
});

describe("animation graph and behaviour tree dock catalogs", () => {
  it("defaults Animation Graph catalogs to State Machine", () => {
    expect(listDockWindows("anim-graph").map((entry) => entry.id)).toEqual(
      listDockWindows("anim-graph", { animEditorMode: "stateMachine" }).map(
        (entry) => entry.id,
      ),
    );
    expect(primaryDockPanel("anim-graph")).toBe("anim-graph-graph");
  });

  it("anchors Animation Graph side docks to the graph", () => {
    for (const entry of listDockWindows("anim-graph")) {
      if (!entry.defaultPosition) continue;
      expect(entry.defaultPosition.referencePanelId).toBe("anim-graph-graph");
    }
  });

  it("focuses the graph as the primary panel", () => {
    expect(primaryDockPanel("anim-graph")).toBe("anim-graph-graph");
    expect(primaryDockPanel("behaviour-tree")).toBe("behaviour-tree-graph");
  });
});

