import { describe, expect, it } from "vitest";
import {
  CLASS_PANEL_INITIAL_HEIGHT,
  CLASS_PANEL_TITLE,
  MATERIAL_SIDE_STACK_WIDTH,
  listDockWindows,
  primaryDockPanel,
  resolveDockInitialWidth,
} from "./window-catalog";
import { listEditorUtilityWindows } from "./editor-utility-windows";

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
  it("lists scene dock tabs with default positions and omits the retired assets dock", () => {
    const windows = listDockWindows("scene");
    expect(windows.map((entry) => entry.id)).toEqual([
      "viewport",
      "scene-outliner",
      "scene-details",
      "output-log",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Viewport",
      "Outliner",
      "Details",
      "Output Log",
    ]);
    expect(windows.some((entry) => entry.id === "mini-asset-browser")).toBe(
      false,
    );

    const outliner = windows.find((entry) => entry.id === "scene-outliner");
    expect(outliner?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "left",
      initialWidth: 260,
    });
    const details = windows.find((entry) => entry.id === "scene-details");
    expect(details?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "right",
      initialWidth: 300,
    });
    const output = windows.find((entry) => entry.id === "output-log");
    expect(output?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "below",
      initialHeight: 160,
    });
  });

  it("lists graph dock tabs including Class stacked under Components", () => {
    const windows = listDockWindows("graph");
    expect(windows.map((entry) => entry.id)).toEqual([
      "graph",
      "prefab-viewport",
      "actor-prefab",
      "my-class",
      "inspector",
      "compiler-results",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Graph",
      "Prefab",
      "Components",
      CLASS_PANEL_TITLE,
      "Inspector",
      "Compiler Results",
    ]);

    const classPanel = windows.find((entry) => entry.id === "my-class");
    expect(classPanel?.defaultPosition).toEqual({
      referencePanelId: "actor-prefab",
      direction: "below",
      initialHeight: CLASS_PANEL_INITIAL_HEIGHT,
    });
  });

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

  it("lists Enum, Structure, and ScriptInterface dock catalogs", () => {
    expect(listDockWindows("enum").map((entry) => entry.id)).toEqual([
      "enum-members",
      "enum-details",
    ]);
    expect(listDockWindows("structure").map((entry) => entry.id)).toEqual([
      "structure-members",
      "structure-details",
    ]);
    expect(listDockWindows("script-interface").map((entry) => entry.id)).toEqual(
      [
        "script-interface-preview",
        "script-interface-methods",
        "script-interface-details",
      ],
    );
    expect(listDockWindows("sprite").map((entry) => entry.id)).toEqual([
      "sprite-preview",
      "sprite-details",
    ]);
    expect(listDockWindows("audio").map((entry) => entry.id)).toEqual([
      "audio-preview",
      "audio-details",
      "audio-clips",
    ]);
    expect(listDockWindows("audio").map((entry) => entry.title)).toEqual([
      "Preview",
      "Details",
      "Clips",
    ]);
    expect(
      listDockWindows("audio").find((entry) => entry.id === "audio-details")
        ?.defaultPosition,
    ).toEqual({
      referencePanelId: "audio-preview",
      direction: "right",
      initialWidth: 280,
    });
    expect(
      listDockWindows("audio").find((entry) => entry.id === "audio-clips")
        ?.defaultPosition,
    ).toEqual({
      referencePanelId: "audio-preview",
      direction: "below",
      initialHeight: 220,
    });
    expect(primaryDockPanel("audio")).toBe("audio-preview");
    expect(listDockWindows("sprite-animation").map((entry) => entry.id)).toEqual([
      "sprite-animation-preview",
      "sprite-animation-details",
    ]);
    expect(listDockWindows("particle-emitter").map((entry) => entry.id)).toEqual([
      "particle-emitter-preview",
      "particle-emitter-details",
    ]);
    expect(listDockWindows("particle-system").map((entry) => entry.id)).toEqual([
      "particle-system-preview",
      "particle-system-details",
    ]);
    expect(
      listDockWindows("particle-emitter").find(
        (entry) => entry.id === "particle-emitter-details",
      )?.defaultPosition,
    ).toEqual({
      referencePanelId: "particle-emitter-preview",
      direction: "right",
      initialWidth: 280,
    });
    expect(primaryDockPanel("particle-emitter")).toBe("particle-emitter-preview");
    expect(primaryDockPanel("particle-system")).toBe("particle-system-preview");
    expect(
      listDockWindows("sprite-animation").find(
        (entry) => entry.id === "sprite-animation-details",
      )?.defaultPosition,
    ).toEqual({
      referencePanelId: "sprite-animation-preview",
      direction: "right",
      initialWidthRatio: 0.75,
    });
    expect(listDockWindows("tileset").map((entry) => entry.id)).toEqual([
      "tileset-preview",
      "tileset-details",
    ]);
    expect(listDockWindows("tilemap").map((entry) => entry.id)).toEqual([
      "tilemap-paint",
      "tilemap-palette",
      "tilemap-details",
    ]);
    expect(
      listDockWindows("tilemap").find((entry) => entry.id === "tilemap-palette"),
    ).toEqual(
      expect.objectContaining({
        title: "Palette",
        defaultPosition: {
          referencePanelId: "tilemap-paint",
          direction: "left",
          initialWidth: 280,
        },
      }),
    );
    expect(listDockWindows("ui").map((entry) => entry.id)).toEqual([
      "ui-design",
      "ui-hierarchy",
      "ui-details",
    ]);
    expect(
      listDockWindows("ui", { editorUtilityInterface: true }).map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "ui-design",
      "ui-hierarchy",
      "ui-details",
      "ui-settings",
    ]);
    expect(listDockWindows("plugin-settings").map((entry) => entry.id)).toEqual([
      "plugin-settings-details",
    ]);
    expect(listDockWindows("plugin-settings").map((entry) => entry.title)).toEqual([
      "Details",
    ]);
  });

  it("lists Designer docks without Logic for UserInterface authoring", () => {
    const windows = listDockWindows("ui", { uiEditorMode: "designer" });
    expect(windows.map((entry) => entry.id)).toEqual([
      "ui-design",
      "ui-hierarchy",
      "ui-details",
    ]);
    expect(windows.some((entry) => entry.id === "ui-logic")).toBe(false);
    expect(windows.some((entry) => entry.id === "graph")).toBe(false);
  });

  it("lists BObject Class docks when UserInterface Logic mode is active", () => {
    const windows = listDockWindows("ui", { uiEditorMode: "logic" });
    expect(windows.map((entry) => entry.id)).toEqual([
      "graph",
      "my-class",
      "inspector",
      "compiler-results",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Graph",
      CLASS_PANEL_TITLE,
      "Inspector",
      "Compiler Results",
    ]);
    expect(windows.some((entry) => entry.id === "ui-design")).toBe(false);
    expect(windows.some((entry) => entry.id === "prefab-viewport")).toBe(false);
  });

  it("uses Design as the Designer primary and Graph as the Logic primary", () => {
    expect(primaryDockPanel("ui")).toBe("ui-design");
    expect(primaryDockPanel("ui", { uiEditorMode: "designer" })).toBe("ui-design");
    expect(primaryDockPanel("ui", { uiEditorMode: "logic" })).toBe("graph");
  });

  it("keeps EUI Settings on Designer and omits it from Logic", () => {
    expect(
      listDockWindows("ui", {
        uiEditorMode: "designer",
        editorUtilityInterface: true,
      }).map((entry) => entry.id),
    ).toEqual(["ui-design", "ui-hierarchy", "ui-details", "ui-settings"]);
    expect(
      listDockWindows("ui", {
        uiEditorMode: "logic",
        editorUtilityInterface: true,
      }).map((entry) => entry.id),
    ).toEqual(["graph", "my-class", "inspector", "compiler-results"]);
  });

  it("anchors Locks to Graph when UI Logic mode is on", () => {
    expect(
      listDockWindows("ui", {
        uiEditorMode: "logic",
        sourceControl: true,
      }).find((entry) => entry.id === "locks")?.defaultPosition?.referencePanelId,
    ).toBe("graph");
    expect(
      listDockWindows("ui", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("ui-design");
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
      "ui",
      "plugin-settings",
      "anim-graph",
      "behaviour-tree",
      "audio-mixer",
      "audio-channel",
      "sound-attenuation",
      "particle-emitter",
      "particle-system",
      "audio",
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
  it("lists Details as the primary Audio Mixer, Channel, and Attenuation docks", () => {
    expect(listDockWindows("audio-mixer").map((entry) => entry.id)).toEqual([
      "audio-mixer-details",
    ]);
    expect(listDockWindows("audio-channel").map((entry) => entry.id)).toEqual([
      "audio-channel-details",
    ]);
    expect(listDockWindows("sound-attenuation").map((entry) => entry.id)).toEqual(
      ["sound-attenuation-details"],
    );
    expect(listDockWindows("audio-mixer").map((entry) => entry.title)).toEqual([
      "Details",
    ]);
    expect(primaryDockPanel("audio-mixer")).toBe("audio-mixer-details");
    expect(primaryDockPanel("audio-channel")).toBe("audio-channel-details");
    expect(primaryDockPanel("sound-attenuation")).toBe(
      "sound-attenuation-details",
    );
  });

  it("lists Graph, Preview, Details and Compiler Results for a Material", () => {
    const windows = listDockWindows("material");
    expect(windows.map((entry) => entry.id)).toEqual([
      "material-graph",
      "material-preview",
      "material-details",
      "material-compiler-results",
    ]);
  });

  it("stacks Details under Preview and keeps Graph about 75% wide", () => {
    const windows = listDockWindows("material");
    const preview = windows.find((entry) => entry.id === "material-preview");
    const details = windows.find((entry) => entry.id === "material-details");
    const compiler = windows.find(
      (entry) => entry.id === "material-compiler-results",
    );
    expect(preview?.defaultPosition).toEqual({
      referencePanelId: "material-graph",
      direction: "left",
      initialWidth: MATERIAL_SIDE_STACK_WIDTH,
    });
    expect(details?.defaultPosition).toEqual({
      referencePanelId: "material-preview",
      direction: "below",
    });
    expect(compiler?.defaultPosition?.referencePanelId).toBe("material-graph");
  });

  it("titles Material docks in Title Case", () => {
    expect(listDockWindows("material").map((entry) => entry.title)).toEqual([
      "Graph",
      "Preview",
      "Details",
      "Compiler Results",
    ]);
  });

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

  it("anchors Locks under the material graph when source control is on", () => {
    expect(
      listDockWindows("material", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("material-graph");
  });
});

describe("animation graph and behaviour tree dock catalogs", () => {
  it("lists Variables, Graph, Details, and Compiler Results for State Machine mode", () => {
    const windows = listDockWindows("anim-graph", {
      animEditorMode: "stateMachine",
    });
    expect(windows.map((entry) => entry.id)).toEqual([
      "anim-graph-graph",
      "anim-graph-variables",
      "anim-graph-details",
      "anim-graph-compiler-results",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Graph",
      "Variables",
      "Details",
      "Compiler Results",
    ]);
  });

  it("lists Graph, Variables, Inspector, and Compiler Results for Animation Object mode", () => {
    const windows = listDockWindows("anim-graph", {
      animEditorMode: "animationObject",
    });
    expect(windows.map((entry) => entry.id)).toEqual([
      "anim-object-graph",
      "anim-object-variables",
      "anim-object-inspector",
      "anim-graph-compiler-results",
    ]);
    expect(primaryDockPanel("anim-graph", { animEditorMode: "animationObject" })).toBe(
      "anim-object-graph",
    );
  });

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

  it("lists Blackboard, Graph, Details, and Compiler Results for a Behaviour Tree", () => {
    const windows = listDockWindows("behaviour-tree");
    expect(windows.map((entry) => entry.id)).toEqual([
      "behaviour-tree-graph",
      "behaviour-tree-blackboard",
      "behaviour-tree-details",
      "behaviour-tree-compiler-results",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Graph",
      "Blackboard",
      "Details",
      "Compiler Results",
    ]);
    expect(
      windows.find((entry) => entry.id === "behaviour-tree-blackboard")
        ?.defaultPosition,
    ).toEqual({
      referencePanelId: "behaviour-tree-graph",
      direction: "left",
      initialWidth: 224,
    });
    expect(
      windows.find((entry) => entry.id === "behaviour-tree-compiler-results")
        ?.defaultPosition,
    ).toEqual({
      referencePanelId: "behaviour-tree-graph",
      direction: "below",
      initialHeight: 160,
    });
  });

  it("focuses the graph as the primary panel", () => {
    expect(primaryDockPanel("anim-graph")).toBe("anim-graph-graph");
    expect(primaryDockPanel("behaviour-tree")).toBe("behaviour-tree-graph");
  });
});

describe("listEditorUtilityWindows", () => {
  it("returns no editor utility tabs when no assets are supplied", () => {
    expect(listEditorUtilityWindows()).toEqual([]);
  });
});
