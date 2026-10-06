import { describe, expect, it } from "vitest";
import {
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
    ]);
    const classPanel = windows.find((entry) => entry.id === "my-class");
    expect(classPanel?.defaultPosition).toEqual({
      referencePanelId: "graph",
      direction: "left",
      initialWidth: 260,
    });
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

  it("opens a Material Instance on its Preview with Details beside it", () => {
    expect(listDockWindows("material-instance").map((entry) => entry.title)).toEqual(["Preview", "Details"]);
    expect(primaryDockPanel("material-instance")).toBe("material-instance-preview");
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

