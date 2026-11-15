import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { SOURCE_CONTROL_ID } from "@haptic/core";
import { SourceControlActionsProvider, useSourceControlActions, useSourceControlDiff, type SourceControlActions } from "../components/source-control-actions";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { SourceControlDiffPickers } from "../components/source-control-diff-pickers";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { sceneActor, sceneAsset, testAsset } from "../testing/diff-assets";
import { integratedSync } from "../testing/integrated-sync";
import { ChangesPanelContents } from "./changes-panel";
import { DiffActorsContents, DiffActorsPanel } from "./diff-actors-panel";
import { DiffContents, DiffPanel } from "./diff-panel";
import { HistoryPanelContents } from "./history-panel";
import { HISTORY_PAGE } from "../services/source-control-history";

// The Source Control tab's Changes, Actors and Diff windows and the toolbar's version pickers,
// together over the real sync and diff services on FakeSync, with real Scene files.

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  openDocument: vi.fn(async () => {}),
  activeDocumentId: null as string | null,
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    openDocument: state.openDocument,
    activeDocumentId: state.activeDocumentId,
  })),
);

// The graph families' canvases load with their editors' chunks; importing those once here keeps that cost out of
// every test's waits.
beforeAll(async () => {
  await Promise.all([import("../shell/asset-panels/rendering"), import("../shell/asset-panels/animation-ai")]);
}, 120_000);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
  state.openDocument.mockClear();
  state.activeDocumentId = null;
});

const PATH = "assets/Forest.scene.hasset";

const light = (intensity: number) => sceneActor("sun", "Directional Light", {
  components: [{ id: "light", classId: "DirectionalLightComponent", properties: { intensity, mobility: "static" } }],
});

async function forest() {
  const base = await sceneAsset([light(2), sceneActor("sky", "Sky Atmosphere"), sceneActor("fence", "Fence 03")]);
  const sync = await integratedSync({ files: { [PATH]: base.bytes } });
  state.sync = sync.service;
  // This copy brightens the sun, removes the fence and adds a bridge.
  const edited = await sceneAsset([light(3.2), sceneActor("sky", "Sky Atmosphere"), sceneActor("bridge", "Bridge")]);
  await sync.storage.writeBinary(PATH, edited.bytes);
  await sync.service.refreshStatus();
  return sync;
}

/** A tap on a tree row, as the TreeView reads it (jsdom has no PointerEvent). */
function tap(element: Element) {
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    Object.defineProperty(event, "isPrimary", { value: true });
    element.dispatchEvent(event);
  }
}

/** A dock window's API as the diff windows read it: whether it is on screen, and when that changes. */
function dockApi(visible: boolean) {
  const listeners = new Set<(event: { isVisible: boolean }) => void>();
  const api = {
    isVisible: visible,
    onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    show(next: boolean) {
      api.isVisible = next;
      for (const listener of listeners) listener({ isVisible: next });
    },
  };
  return api;
}

/** A graph family's asset at two versions, and what its canvas draws: each node's id with its tag (null when plain). */
interface GraphFamilyCase {
  label: string;
  type: string;
  name: string;
  path: string;
  canvas: string;
  versions: [unknown, unknown];
  overlay: Array<[string, string | null]>;
  base: Array<[string, string | null]>;
  compare: Array<[string, string | null]>;
  /** One changed node's value as the canvas lists it under the node. */
  change: { node: string; name: string; base: string; compare: string };
  /** That the family's own node components drew it. */
  drawnBy: (graph: HTMLElement) => void;
}

const pinNode = (id: string, type: string, properties: Record<string, unknown> = {}, x = 0, y = 0) => ({ id, type, position: { x, y }, properties });
const pinWire = (id: string, from: string, to: string, toPin: string) => ({ id, sourceNodeId: from, sourcePinId: "out", targetNodeId: to, targetPinId: toPin });
const treeNode = (id: string, kind: string, classId: string, children: string[], properties: Record<string, unknown> = {}) => ({ id, kind, classId, children, decorators: [], services: [], properties });
const animState = (id: string, name: string, x: number) => ({ id, name, position: { x, y: 0 }, stateGraph: { nodes: [], edges: [] } });
const animTransition = (id: string, from: string, to: string) => ({ id, fromStateId: from, toStateId: to, blendSeconds: 0.2, priority: 0, ruleGraph: { nodes: [], edges: [] } });

const GRAPH_FAMILIES: GraphFamilyCase[] = [
  {
    label: "Material",
    type: "Material",
    name: "Water",
    path: "assets/Water.material.hasset",
    canvas: "material",
    versions: [0.5, 0.25].map((roughness, index) => ({
      name: "Water", domain: "surface", shadingModel: "pbr", blendMode: "opaque", twoSided: false,
      // The working copy calls a Material Function, which no diff loads: the call draws without pins.
      nodes: [pinNode("out", "output.surface", { "default:roughness": [roughness] }), ...(index === 0 ? [pinNode("mul", "math.multiply", {}, -300)] : [pinNode("tint", "const.float", { value: [2] }, -300), pinNode("fn", "function.call", { functionGuid: "fresnel" }, -300, 300)])],
      edges: index === 0 ? [pinWire("e1", "mul", "out", "roughness")] : [pinWire("e2", "tint", "out", "metallic"), pinWire("e3", "fn", "out", "specular")],
    })) as [unknown, unknown],
    overlay: [["out", "changed"], ["tint", "added"], ["fn", "added"], ["mul", "removed"]],
    base: [["out", "changed"], ["mul", "removed"]],
    compare: [["out", "changed"], ["tint", "added"], ["fn", "added"]],
    change: { node: "out", name: "Roughness", base: "0.5", compare: "0.25" },
    drawnBy: (graph) => expect(within(graph).getByText("Material Output")).toBeTruthy(),
  },
  {
    label: "Particle Graph",
    type: "ParticleGraph",
    name: "Sparks",
    path: "assets/Sparks.particlegraph.hasset",
    canvas: "particle",
    versions: [30, 60].map((emitRate, index) => ({
      name: "Sparks", materialGuid: null,
      settings: { capacity: 256, loop: "infinite", duration: 1, prewarm: 0, blendMode: "additive", billboard: "camera" },
      parameters: [],
      nodes: [pinNode("out", "particle.output", { "default:emitRate": [emitRate] }), pinNode("create", "particle.create", {}, -300), ...(index === 0 ? [pinNode("c", "const.float", { value: [3] }, -600)] : [])],
      edges: [],
    })) as [unknown, unknown],
    overlay: [["out", "changed"], ["create", null], ["c", "removed"]],
    base: [["out", "changed"], ["create", null], ["c", "removed"]],
    compare: [["out", "changed"], ["create", null]],
    change: { node: "out", name: "Emit Rate", base: "30", compare: "60" },
    drawnBy: (graph) => expect(within(graph).getByText("Emitter Output")).toBeTruthy(),
  },
  {
    label: "Behaviour Tree",
    type: "BehaviourTree",
    name: "Guard",
    path: "assets/Guard.behaviourtree.hasset",
    canvas: "behaviour-tree",
    versions: ([[1000, "fail"], [2000, "succeed"]] as const).map(([durationMs, child]) => ({
      name: "Guard", rootId: "root", blackboardGuid: null,
      nodes: [treeNode("root", "sequence", "bt.composite.sequence", ["wait", child]), treeNode("wait", "task", "bt.task.wait", [], { durationMs }), treeNode(child, "task", `bt.task.${child}`, [])],
      editorPositions: { root: { x: 0, y: 0 }, wait: { x: -160, y: 200 }, [child]: { x: 160, y: 200 } },
    })) as [unknown, unknown],
    overlay: [["root", "changed"], ["wait", "changed"], ["succeed", "added"], ["fail", "removed"]],
    base: [["root", "changed"], ["wait", "changed"], ["fail", "removed"]],
    compare: [["root", "changed"], ["wait", "changed"], ["succeed", "added"]],
    change: { node: "wait", name: "Duration MS", base: "1000", compare: "2000" },
    drawnBy: (graph) => expect(within(graph).getByTestId("bt-node-wait")).toBeTruthy(),
  },
  {
    label: "Animation Graph",
    type: "AnimationGraph3D",
    name: "Locomotion",
    path: "assets/Locomotion.animgraph.hasset",
    canvas: "state-machine",
    versions: [false, true].map((run) => ({
      name: "Locomotion", variables: [],
      stateMachine: {
        entryStateId: "idle",
        states: [animState("idle", "Idle", 0), animState("walk", run ? "Walking" : "Walk", 240), run ? animState("run", "Run", 480) : animState("jump", "Jump", 480)],
        transitions: [animTransition("t1", "idle", "walk"), ...(run ? [animTransition("t2", "walk", "run")] : [])],
        aliases: [],
      },
    })) as [unknown, unknown],
    overlay: [["idle", null], ["walk", "changed"], ["run", "added"], ["jump", "removed"]],
    base: [["idle", null], ["walk", "changed"], ["jump", "removed"]],
    compare: [["idle", null], ["walk", "changed"], ["run", "added"]],
    change: { node: "walk", name: "Name", base: "Walk", compare: "Walking" },
    drawnBy: (graph) => expect(within(graph).getByTestId("anim-state-node-run")).toBeTruthy(),
  },
];

/** Commits the family's first version and writes its second as the working copy. */
async function openGraphDiff(family: GraphFamilyCase) {
  const asset = (document: unknown) => testAsset(family.type, family.name, { document });
  const sync = await integratedSync({ files: { [family.path]: (await asset(family.versions[0])).bytes } });
  state.sync = sync.service;
  await sync.storage.writeBinary(family.path, (await asset(family.versions[1])).bytes);
  await sync.service.refreshStatus();
}

/** The canvas's nodes in the order drawn, each with its diff tag. */
function canvasTags(graph: HTMLElement): Array<[string, string | null]> {
  return [...graph.querySelectorAll<HTMLElement>(".react-flow__node")].map((node) => [node.dataset.id!, node.querySelector<HTMLElement>("[data-diff-status]")?.dataset.diffStatus ?? null]);
}

let diffService: ReturnType<typeof useSourceControlDiff> | null = null;
function CaptureDiff() {
  diffService = useSourceControlDiff();
  return null;
}

function renderTab() {
  return render(
    <SourceControlActionsProvider>
      <CaptureDiff />
      <SourceControlDiffPickers />
      <ChangesPanelContents />
      <DiffActorsContents />
      <DiffContents />
    </SourceControlActionsProvider>,
  );
}

describe("Source Control diff windows", () => {
  it("opens a Changes row's diff: actors marked with counts, and the chosen actor's properties side by side or inline", async () => {
    await forest();
    renderTab();
    expect(screen.getByTestId("diff-panel-placeholder").textContent).toContain("Choose a change");
    expect(screen.queryByTestId("diff-pickers")).toBeNull();

    fireEvent.click(await screen.findByTestId(`changes-open-${PATH}`));
    expect(screen.getByTestId(`changes-row-${PATH}`).dataset.selected).toBe("true");
    const tree = await screen.findByTestId("diff-actors-tree");
    expect(screen.getByTestId("diff-counts").textContent).toBe("1 Added1 Removed1 Changed");
    const label = (name: string) => within(tree).getByText(name);
    expect(label("Directional Light").dataset.tone).toBe("warning");
    expect(label("Bridge").dataset.tone).toBe("success");
    expect(label("Fence 03").dataset.tone).toBe("destructive");
    expect(label("Sky Atmosphere").className).toContain("text-muted-foreground");

    // The first changed actor is shown: its changed cells tinted, both versions named.
    expect(screen.getByTestId("diff-item-name").textContent).toBe("Directional Light");
    const intensity = screen.getByTestId("diff-row-properties.intensity");
    expect(intensity.dataset.changed).toBe("true");
    expect(intensity.textContent).toBe("Intensity23.2");
    expect(screen.getByTestId("diff-properties").textContent).toContain("Base (main · ");
    expect(screen.getByTestId("diff-properties").textContent).toContain("Working Copy");
    expect(screen.getByTestId("diff-row-properties.mobility").dataset.changed).toBeUndefined();

    fireEvent.click(screen.getByTestId("diff-changed-only"));
    await waitFor(() => expect(screen.queryByTestId("diff-row-properties.mobility")).toBeNull());
    fireEvent.click(screen.getByTestId("diff-layout-inline"));
    expect(within(screen.getByTestId("diff-row-properties.intensity")).getByText("2").tagName).toBe("DEL");

    // Search keeps matching actors; choosing one shows it.
    fireEvent.change(screen.getByTestId("diff-actors-search"), { target: { value: "bri" } });
    expect(within(tree).queryByText("Sky Atmosphere")).toBeNull();
    act(() => tap(screen.getByTestId("tree-row-bridge")));
    expect(screen.getByTestId("diff-item-name").textContent).toBe("Bridge");

    fireEvent.click(screen.getByTestId("diff-open-asset"));
    expect(state.openDocument).toHaveBeenCalledWith({ kind: "scene", path: PATH, label: "Forest" });
  });

  it("compares other versions from the toolbar's pickers, and offers no revert to the working copy", async () => {
    const { service } = await forest();
    renderTab();
    fireEvent.click(await screen.findByTestId(`changes-open-${PATH}`));
    await screen.findByTestId("diff-actors-tree");
    expect(screen.getByTestId("diff-base").textContent).toContain(`main · ${service.getSnapshot().head!.slice(0, 7)}`);
    expect(screen.getByTestId("diff-compare").textContent).toContain("Working Copy");
    expect((screen.getByTestId("diff-revert") as HTMLButtonElement).disabled).toBe(false);

    // Working copy as the base: both sides swap, and there is nothing to revert to.
    act(() => diffService!.setRefs({ base: { kind: "working" }, compare: { kind: "head" } }));
    await waitFor(() => expect(within(screen.getByTestId("diff-actors-tree")).getByText("Fence 03").dataset.tone).toBe("success"));
    expect(screen.getByTestId("diff-counts").textContent).toBe("1 Added1 Removed1 Changed");
    expect(screen.getByTestId("diff-base").textContent).toContain("Working Copy");
    expect((screen.getByTestId("diff-revert") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before reverting the asset to its base version", async () => {
    const { storage } = await forest();
    renderTab();
    fireEvent.click(await screen.findByTestId(`changes-open-${PATH}`));
    await screen.findByTestId("diff-actors-tree");
    fireEvent.click(screen.getByTestId("diff-revert"));
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain("Revert Forest?");
    expect(confirm.textContent).toContain("It cannot be undone.");
    const before = await storage.readBinary(PATH);
    fireEvent.click(screen.getByTestId("source-control-revert-cancel"));
    await waitFor(() => expect(screen.queryByTestId("source-control-revert-confirm")).toBeNull());
    expect(await storage.readBinary(PATH)).toEqual(before);
  });

  it("draws a graph diff on the read-only canvas: nodes tagged by what changed, the old pin value struck through beside the new", async () => {
    const pin = { id: "speed", name: "Max Walk Speed", kind: "data", direction: "in", type: { kind: "float" } };
    const node = (id: string, title: string, data: Record<string, unknown> = {}) => ({ id, type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: "call.custom", title, __pins: [pin], ...data } });
    const graph = (speed: number, last: string) => ({ nodes: [node("set", "Set Max Walk Speed", { "default:speed": speed }), node(last, last)], edges: [], members: [] });
    const path = "assets/Player.class.hasset";
    const sync = await integratedSync({ files: { [path]: (await testAsset("Class", "Player", { document: graph(600, "Print String") })).bytes } });
    state.sync = sync.service;
    await sync.storage.writeBinary(path, (await testAsset("Class", "Player", { document: graph(750, "Play Sound 2D") })).bytes);
    await sync.service.refreshStatus();
    renderTab();
    act(() => diffService!.open({ path, name: "Player", type: "Class" }));
    const canvas = await screen.findByTestId("diff-graph", {}, { timeout: 5000 });
    await waitFor(() => expect(canvas.querySelectorAll("[data-diff-status]").length).toBe(3));
    const statuses = [...canvas.querySelectorAll<HTMLElement>("[data-diff-status]")].map((element) => [element.textContent?.includes("Play Sound 2D") ? "Play Sound 2D" : element.textContent?.includes("Print String") ? "Print String" : "Set Max Walk Speed", element.dataset.diffStatus]);
    expect(statuses).toEqual([["Set Max Walk Speed", "changed"], ["Play Sound 2D", "added"], ["Print String", "removed"]]);
    const values = within(canvas).getByTestId("diff-pin-changes");
    expect(within(values).getByText("600").tagName).toBe("DEL");
    expect(within(values).getByText("750").tagName).toBe("SPAN");
    // The Actors window lists the graph and its changed nodes.
    expect(within(screen.getByTestId("diff-actors-tree")).getByText("Play Sound 2D").dataset.tone).toBe("success");

    fireEvent.click(screen.getByTestId("diff-graph-base"));
    await waitFor(() => expect(canvas.querySelectorAll("[data-diff-status]").length).toBe(2));
  });

  it("compares a Texture's facts and counts the Materials that use it, with no preview where none decodes", async () => {
    const path = "assets/Rock.texture.hasset";
    const texture = (width: number) => testAsset("Texture", "Rock", { payload: { width, height: width, usage: "albedo" }, chunks: [{ id: "source", kind: "source", mime: "image/png", data: new Uint8Array(64).fill(width % 251) }] });
    const sync = await integratedSync({ files: { [path]: (await texture(1024)).bytes } });
    state.sync = sync.service;
    await sync.storage.writeBinary(path, (await texture(2048)).bytes);
    await sync.service.refreshStatus();
    renderTab();
    act(() => diffService!.open({ path, name: "Rock", type: "Texture" }));
    expect((await screen.findByTestId("diff-row-size")).textContent).toBe("Size1024 × 10242048 × 2048");
    expect(screen.getByTestId("diff-row-source").dataset.changed).toBe("true");
    expect(screen.getByTestId("diff-texture-base-none").textContent).toBe("No Preview");
    expect(screen.getByTestId("diff-texture-materials").textContent).toBe("Used By 0 Materials");
  });

  // Each family's graph on its own canvas, loaded with its editor's chunk: its own node components, tagged by what changed.
  for (const family of GRAPH_FAMILIES) {
    it(`draws the diff of the ${family.label} on its own canvas, tagged in Overlay, Base and Working Copy`, async () => {
      await openGraphDiff(family);
      renderTab();
      act(() => diffService!.open({ path: family.path, name: family.name, type: family.type }));
      const graph = await screen.findByTestId("diff-graph", {}, { timeout: 4_000 });
      expect(graph.dataset.canvas).toBe(family.canvas);
      await waitFor(() => expect(canvasTags(graph)).toEqual(family.overlay), { timeout: 4_000 });
      // One editor draws both versions.
      expect(graph.querySelectorAll(".react-flow")).toHaveLength(1);
      family.drawnBy(graph);
      const changed = graph.querySelector<HTMLElement>(`.react-flow__node[data-id="${family.change.node}"]`)!;
      const changes = within(changed).getByTestId("diff-pin-changes");
      expect(within(changes).getByText(family.change.name)).toBeTruthy();
      expect(within(changes).getByText(family.change.base).tagName).toBe("DEL");
      expect(within(changes).getByText(family.change.compare).tagName).toBe("SPAN");

      fireEvent.click(screen.getByTestId("diff-graph-base"));
      await waitFor(() => expect(canvasTags(graph)).toEqual(family.base));
      fireEvent.click(screen.getByTestId("diff-graph-compare"));
      expect(screen.getByTestId("diff-graph-compare").textContent).toBe("Working Copy");
      await waitFor(() => expect(canvasTags(graph)).toEqual(family.compare));
    });
  }

  it("shows a graph family's asset header and chunks from the asset's row", async () => {
    const material = GRAPH_FAMILIES[0]!;
    await openGraphDiff(material);
    renderTab();
    act(() => diffService!.open({ path: material.path, name: material.name, type: material.type }));
    await screen.findByTestId("diff-graph", {}, { timeout: 4_000 });
    // The node's row says what changed in it.
    expect(screen.getByTestId("tree-row-graph/out").textContent).toContain("Roughness: 0.5 → 0.25");
    act(() => tap(screen.getByTestId("tree-row-asset")));
    expect(screen.getByTestId("diff-item-name").textContent).toBe("Water");
    expect(screen.queryByTestId("diff-graph")).toBeNull();
    expect(screen.getByTestId("diff-row-chunk:document").dataset.changed).toBe("true");
    // The header's name and the document's.
    expect(screen.getAllByTestId("diff-row-name").map((row) => row.dataset.changed)).toEqual([undefined, undefined]);
  });

  it("mounts a graph canvas only while the Diff window is on screen", async () => {
    const material = GRAPH_FAMILIES[0]!;
    await openGraphDiff(material);
    const actors = dockApi(true);
    const diffWindow = dockApi(false);
    render(
      <SourceControlActionsProvider>
        <CaptureDiff />
        <DiffActorsPanel {...({ api: actors } as unknown as IDockviewPanelProps)} />
        <DiffPanel {...({ api: diffWindow } as unknown as IDockviewPanelProps)} />
      </SourceControlActionsProvider>,
    );
    // Loaded for the Actors window; the hidden Diff window draws no canvas.
    act(() => diffService!.open({ path: material.path, name: material.name, type: material.type }));
    const graph = await screen.findByTestId("diff-graph", {}, { timeout: 4_000 });
    expect(within(screen.getByTestId("diff-actors-tree")).getByText("Float").dataset.tone).toBe("success");
    expect(graph.querySelector(".react-flow")).toBeNull();
    act(() => diffWindow.show(true));
    await waitFor(() => expect(canvasTags(graph)).toEqual(material.overlay), { timeout: 4_000 });
    act(() => diffWindow.show(false));
    expect(graph.querySelector(".react-flow")).toBeNull();
  });

  it("reads nothing while neither window is on screen, and loads what changed once one is shown again", async () => {
    const { service, storage } = await forest();
    const reads = vi.spyOn(service, "readWorking");
    const stamps = vi.spyOn(service, "workingStamp");
    const loads = () => reads.mock.calls.filter(([path]) => path === PATH).length;
    const actors = dockApi(false);
    const diffWindow = dockApi(false);
    render(
      <SourceControlActionsProvider>
        <CaptureDiff />
        <DiffActorsPanel {...({ api: actors } as unknown as IDockviewPanelProps)} />
        <DiffPanel {...({ api: diffWindow } as unknown as IDockviewPanelProps)} />
      </SourceControlActionsProvider>,
    );
    // Opened while another tab is in front: nothing is read until a window shows it.
    act(() => diffService!.open({ path: PATH, name: "Forest", type: "Scene" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(loads()).toBe(0);
    act(() => diffWindow.show(true));
    await screen.findByTestId("diff-item-name");
    expect(loads()).toBe(1);

    // The tab is left: an Auto-Save of the Scene and its status read nothing for the diff.
    act(() => diffWindow.show(false));
    stamps.mockClear();
    await storage.writeBinary(PATH, (await sceneAsset([light(5), sceneActor("sky", "Sky Atmosphere")])).bytes);
    await act(() => service.refreshStatus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(stamps).not.toHaveBeenCalled();
    expect(loads()).toBe(1);

    // Back on screen: the save is found and loaded once.
    act(() => actors.show(true));
    await waitFor(() => expect(loads()).toBe(2));
    await waitFor(() => expect(screen.getByTestId("diff-counts").textContent).toBe("0 Added1 Removed1 Changed"));
  });

  it("counts the windows as hidden while another document's tab is in front of the Source Control tab", async () => {
    const { service } = await forest();
    const reads = vi.spyOn(service, "readWorking");
    state.activeDocumentId = "scene:assets/Forest.scene.hasset";
    const tab = () => (
      <SourceControlActionsProvider>
        <CaptureDiff />
        <DocumentWorkspaceProvider documentId={SOURCE_CONTROL_ID}>
          <DiffPanel {...({ api: dockApi(true) } as unknown as IDockviewPanelProps)} />
        </DocumentWorkspaceProvider>
      </SourceControlActionsProvider>
    );
    const view = render(tab());
    act(() => diffService!.open({ path: PATH, name: "Forest", type: "Scene" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(reads).not.toHaveBeenCalled();
    state.activeDocumentId = SOURCE_CONTROL_ID;
    view.rerender(tab());
    await screen.findByTestId("diff-item-name");
    expect(reads.mock.calls.filter(([path]) => path === PATH)).toHaveLength(1);
  });

  it("offers History's commits of the asset in both pickers, read once with History's, and older pages through Load Older", async () => {
    const ROCK = "assets/Rock.texture.hasset";
    const sync = await integratedSync();
    state.sync = sync.service;
    for (let index = 0; index < HISTORY_PAGE + 10; index += 1) sync.remote.commit({ [ROCK]: `R${index}` }, `Rock ${index}`);
    await sync.service.pull();
    const all = (await sync.service.history({ limit: HISTORY_PAGE + 20, path: ROCK })).commits;
    const byMessage = (message: string) => all.find((commit) => commit.message === message)!.id;
    const read = vi.spyOn(sync.service, "history");
    // History reads every asset's list until it is shown Rock's.
    const rockReads = () => read.mock.calls.map(([options]) => options).filter((options) => options.path === ROCK);
    let actions: SourceControlActions | null = null;
    function Actions() {
      actions = useSourceControlActions();
      return null;
    }
    // jsdom lays nothing out: give scroll regions a height of ten rows, so long lists window.
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("data-slot") === "scroll-area-viewport" ? 280 : 0;
    });
    onTestFinished(() => height.mockRestore());
    render(
      <SourceControlActionsProvider>
        <Actions />
        <CaptureDiff />
        <SourceControlDiffPickers />
        <HistoryPanelContents />
      </SourceControlActionsProvider>,
    );
    act(() => actions!.openDiff({ path: ROCK, name: "Rock", type: "Texture" }));
    await screen.findByTestId("history-load-older");

    // Past the 20 the pickers once listed: the first page History read.
    fireEvent.click(screen.getByTestId("diff-base"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`diff-base-${byMessage("Rock 25")}`));
    });
    expect(diffService!.getSnapshot().target?.base).toEqual({ kind: "commit", id: byMessage("Rock 25") });
    fireEvent.click(screen.getByTestId("diff-compare"));
    expect(await screen.findByTestId(`diff-compare-${byMessage("Rock 30")}`)).toBeTruthy();
    expect(rockReads()).toEqual([{ limit: HISTORY_PAGE, path: ROCK }]);

    // Load Older reads History's next page, for History too.
    await act(async () => {
      fireEvent.click(screen.getByTestId("diff-compare-load-older"));
    });
    await waitFor(() => expect(screen.queryByTestId("history-load-older")).toBeNull());
    expect(rockReads()).toEqual([
      { limit: HISTORY_PAGE, path: ROCK },
      { limit: HISTORY_PAGE, skip: HISTORY_PAGE, deepen: true, path: ROCK },
    ]);
    expect(screen.queryByTestId("diff-compare-load-older")).toBeNull();
    // A long list is windowed: its end mounts once scrolled to.
    const commits = screen.getByTestId("diff-compare-commits");
    const viewport = commits.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']")!;
    expect(screen.queryByTestId(`diff-compare-${byMessage("Rock 0")}`)).toBeNull();
    // Scrolled to its end (jsdom keeps no scroll position of its own).
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 61 * 28 - 280 });
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`diff-compare-${byMessage("Rock 0")}`));
    });
    expect(diffService!.getSnapshot().target?.compare).toEqual({ kind: "commit", id: byMessage("Rock 0") });
  });

  it("reads the asset's commits again while a picker's menu stays open across a commit", async () => {
    const ROCK = "assets/Rock.texture.hasset";
    const sync = await integratedSync();
    state.sync = sync.service;
    sync.remote.commit({ [ROCK]: "R1" }, "Rock 1");
    await sync.service.pull();
    const first = sync.service.getSnapshot().head!;
    let actions: SourceControlActions | null = null;
    function Actions() {
      actions = useSourceControlActions();
      return null;
    }
    render(
      <SourceControlActionsProvider>
        <Actions />
        <SourceControlDiffPickers />
      </SourceControlActionsProvider>,
    );
    act(() => actions!.openDiff({ path: ROCK, name: "Rock", type: "Texture" }));
    fireEvent.click(await screen.findByTestId("diff-base"));
    expect(await screen.findByTestId(`diff-base-${first}`)).toBeTruthy();

    // The menu is not modal: a commit moves HEAD while it stays open.
    await sync.storage.writeText(ROCK, "R2");
    await sync.service.refreshStatus();
    await act(async () => {
      await sync.service.commit({ rowIds: new Set([ROCK]), message: "Rock 2", push: false });
    });
    const second = sync.service.getSnapshot().head!;
    expect(second).not.toBe(first);
    expect(await screen.findByTestId(`diff-base-${second}`)).toBeTruthy();
    expect(screen.getByTestId(`diff-base-${first}`)).toBeTruthy();
    expect(screen.queryByText("Reading History…")).toBeNull();
  });

  it("shows why a version cannot be compared", async () => {
    await forest();
    renderTab();
    // Seeded as text, not an asset.
    act(() => diffService!.open({ path: "assets/Rock.texture.hasset", name: "Rock", type: "Texture" }));
    await waitFor(() => expect(screen.getByTestId("diff-actors-panel-placeholder").textContent).toContain("Could Not Compare Rock"));
    expect(screen.getByTestId("diff-panel-placeholder").textContent).toContain(".hasset");
  });
});
