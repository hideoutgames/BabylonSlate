import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type {
  SessionReportAsset,
  SessionReportLocationSources,
} from "../lib/session-report-locations";
import {
  PreviewSessionReport,
  type PreviewSessionReportProps,
} from "./preview-session-report";

afterEach(cleanup);

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

const HERO: SessionReportAsset = {
  guid: "hero-guid",
  path: "assets/Hero.class.babasset",
  name: "Hero",
  type: "Class",
};
const ENEMY_AI: SessionReportAsset = {
  guid: "enemy-ai-guid",
  path: "assets/EnemyAI.bt.babasset",
  name: "Enemy AI",
  type: "BehaviourTree",
};

function tree(taskClassId: string) {
  return {
    name: "Enemy AI",
    rootId: "root",
    blackboardGuid: null,
    nodes: [
      { id: "root", kind: "selector", classId: "bt.composite.selector", children: ["move"] },
      { id: "move", kind: "task", classId: taskClassId, children: [] },
    ],
  };
}

const HERO_GRAPH = {
  nodes: [
    { id: "print", type: "debug.printString", position: { x: 0, y: 0 }, data: {} },
  ],
  edges: [],
  functionGraphs: {
    jump: {
      nodes: [
        { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
    },
  },
};

function sources(overrides: Partial<SessionReportLocationSources> = {}): SessionReportLocationSources {
  const assets = [HERO, ENEMY_AI];
  return {
    // Class scripts report their path, behaviour trees their guid.
    findAsset: (ref) => assets.find((asset) => asset.guid === ref || asset.path === ref),
    // Enemy AI is open with an unsaved task change; Hero is closed.
    openContent: (asset) => (asset.guid === ENEMY_AI.guid ? tree("bt.task.moveTo") : undefined),
    readContent: async (asset) =>
      asset.guid === HERO.guid ? HERO_GRAPH : tree("bt.task.wait"),
    ...overrides,
  };
}

function renderReport(
  entries: SessionReportEntry[],
  locationSources?: SessionReportLocationSources,
  onNavigate: PreviewSessionReportProps["onNavigate"] = vi.fn(),
  onOpenChange: PreviewSessionReportProps["onOpenChange"] = () => undefined,
) {
  render(
    <>
      <button type="button" data-testid="editor-behind">Editor</button>
      <PreviewSessionReport
        open
        entries={entries}
        dropped={0}
        onOpenChange={onOpenChange}
        onNavigate={onNavigate}
        locationSources={locationSources}
      />
    </>,
  );
  return onNavigate;
}

function group(name: string): HTMLElement {
  const toggle = screen
    .getAllByTestId("session-report-group-toggle")
    .find((candidate) => candidate.textContent?.includes(name));
  if (!toggle) throw new Error(`No group named ${name}`);
  return toggle.closest('[data-testid="session-report-group"]') as HTMLElement;
}

function expand(name: string): HTMLElement {
  const section = group(name);
  fireEvent.click(within(section).getByTestId("session-report-group-toggle"));
  return section;
}

it("groups entries by asset, collapsed, with per-severity counts", async () => {
  renderReport(
    [
      entry({ assetGuid: HERO.path, nodeId: "print" }),
      entry({ assetGuid: ENEMY_AI.guid, btNodeId: "move", code: "bt.failed" }),
      entry({ assetGuid: HERO.path, nodeId: "begin", severity: "warning", code: "runtime.log" }),
      entry({ assetGuid: HERO.path, nodeId: "print", code: "runtime.log" }),
    ],
    sources(),
  );
  await screen.findByText("Enemy AI");

  expect(screen.getAllByTestId("session-report-group")).toHaveLength(2);
  expect(screen.queryAllByTestId("session-report-row")).toHaveLength(0);
  const hero = group("Hero");
  expect(within(hero).getByTestId("session-report-group-counts").textContent).toBe(
    "2 Errors1 Warning",
  );
  expect(within(group("Enemy AI")).getByTestId("session-report-group-counts").textContent).toBe(
    "1 Error",
  );

  const toggle = within(hero).getByTestId("session-report-group-toggle");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(within(hero).getAllByTestId("session-report-row")).toHaveLength(3);
  expect(screen.getAllByTestId("session-report-row")).toHaveLength(3);
  fireEvent.click(toggle);
  expect(screen.queryAllByTestId("session-report-row")).toHaveLength(0);
});

it("names closed assets from their saved document, including function graph nodes", async () => {
  renderReport(
    [
      entry({ assetGuid: HERO.path, nodeId: "print" }),
      entry({ assetGuid: HERO.path, nodeId: "begin", code: "runtime.log" }),
    ],
    sources(),
  );
  await screen.findByText("Hero");
  const rows = within(expand("Hero")).getAllByTestId("session-report-row");
  await waitFor(() => {
    expect(rows[0]!.textContent).toContain("Hero › Print String");
    expect(rows[1]!.textContent).toContain("Hero › Event Begin Play");
  });
});

it("names open assets from their working content instead of the saved document", async () => {
  renderReport([entry({ assetGuid: ENEMY_AI.guid, btNodeId: "move" })], sources());
  await screen.findByText("Enemy AI");
  const [row] = within(expand("Enemy AI")).getAllByTestId("session-report-row");
  await waitFor(() => expect(row!.textContent).toContain("Enemy AI › Move To"));
  expect(row!.textContent).not.toContain("Wait");
});

it("falls back to raw ids when an asset or its document cannot be resolved", async () => {
  renderReport(
    [
      entry({ assetGuid: "missing-guid", nodeId: "n1" }),
      entry({ assetGuid: HERO.path, nodeId: "print" }),
      entry({ nodeId: "orphan" }),
    ],
    sources({
      readContent: async () => {
        throw new Error("corrupt document");
      },
    }),
  );
  // The indexed name survives a failed read; the node keeps its raw id.
  await screen.findByText("Hero");
  expect(within(expand("Hero")).getByTestId("session-report-row").textContent).toContain(
    "Hero › print",
  );
  // An entry with no asset to open says so instead of pointing at a raw id.
  expect(within(expand("missing-guid")).getByTestId("session-report-row").textContent).toContain(
    "No Source",
  );
  expect(within(expand("Unknown Asset")).getByTestId("session-report-row").textContent).toContain(
    "No Source",
  );
});

it("navigates with the clicked entry and exposes its node id", async () => {
  const target = entry({ assetGuid: ENEMY_AI.guid, btNodeId: "move" });
  const onNavigate = renderReport([target], sources());
  await screen.findByText("Enemy AI");
  const row = within(expand("Enemy AI")).getByTestId("session-report-row");
  expect(row.getAttribute("data-node-id")).toBe("move");
  fireEvent.click(row);
  expect(onNavigate).toHaveBeenCalledWith(target);
});

it("stays open, over a usable editor, while rows open their sources", async () => {
  const onOpenChange = vi.fn();
  const onNavigate = vi.fn(async () => ({ opened: true as const }));
  renderReport(
    [
      entry({ assetGuid: ENEMY_AI.guid, btNodeId: "move" }),
      entry({ assetGuid: HERO.path, nodeId: "print", code: "runtime.log" }),
    ],
    sources(),
    onNavigate,
    onOpenChange,
  );
  await screen.findByText("Enemy AI");
  expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  expect(screen.getByTestId("preview-session-report").getAttribute("aria-modal")).toBeNull();

  fireEvent.click(within(expand("Enemy AI")).getByTestId("session-report-row"));
  await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
  // A second row can be chosen straight away: the report is still there to consult.
  fireEvent.click(within(expand("Hero")).getByTestId("session-report-row"));
  await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));

  // Pressing the editor behind the report does not dismiss it.
  const editor = screen.getByTestId("editor-behind");
  fireEvent.pointerDown(editor);
  fireEvent.mouseDown(editor);
  fireEvent.pointerUp(editor);
  fireEvent.mouseUp(editor);
  fireEvent.click(editor);
  act(() => editor.focus());

  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("preview-session-report")).toBeTruthy();
});

it("closes through Close, the title-bar close, or Escape pressed inside the report", () => {
  const onOpenChange = vi.fn();
  renderReport([entry({ assetGuid: HERO.path, nodeId: "print" })], sources(), vi.fn(), onOpenChange);

  fireEvent.click(screen.getByTestId("session-report-close"));
  expect(onOpenChange.mock.lastCall?.[0]).toBe(false);
  onOpenChange.mockClear();

  fireEvent.click(document.querySelector('[data-slot="dialog-close"]')!);
  expect(onOpenChange.mock.lastCall?.[0]).toBe(false);
  onOpenChange.mockClear();

  const copy = screen.getByTestId("session-report-copy");
  act(() => copy.focus());
  fireEvent.keyDown(copy, { key: "Escape" });
  expect(onOpenChange.mock.lastCall?.[0]).toBe(false);
});

it("leaves Escape to the editor when the keyboard is outside the report", () => {
  const onOpenChange = vi.fn();
  renderReport([entry({ assetGuid: HERO.path, nodeId: "print" })], sources(), vi.fn(), onOpenChange);
  // The editor's own Escape handling (cancel a wire, clear a selection, close a menu) still runs.
  const reachedEditor = vi.fn();
  window.addEventListener("keydown", reachedEditor);

  const editor = screen.getByTestId("editor-behind");
  act(() => editor.focus());
  const notPrevented = fireEvent.keyDown(editor, { key: "Escape" });

  window.removeEventListener("keydown", reachedEditor);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(reachedEditor).toHaveBeenCalledTimes(1);
  expect(notPrevented).toBe(true);
  expect(screen.getByTestId("preview-session-report")).toBeTruthy();
});

it("says why a chosen row opened nothing, and clears the note once another row opens", async () => {
  const onNavigate = vi.fn<PreviewSessionReportProps["onNavigate"]>(async (target) =>
    target.assetGuid
      ? { opened: true }
      : { opened: false, message: "This entry names no asset, so there is no source to open." },
  );
  renderReport(
    [entry({ nodeId: "orphan" }), entry({ assetGuid: HERO.path, nodeId: "print", code: "runtime.log" })],
    sources(),
    onNavigate,
  );
  await screen.findByText("Hero");
  expect(screen.queryByTestId("session-report-notice")).toBeNull();

  fireEvent.click(within(expand("Unknown Asset")).getByTestId("session-report-row"));
  expect((await screen.findByTestId("session-report-notice")).textContent).toContain("no source to open");

  fireEvent.click(within(expand("Hero")).getByTestId("session-report-row"));
  await waitFor(() => expect(screen.queryByTestId("session-report-notice")).toBeNull());
});

it("keeps a refused open readable instead of failing silently", async () => {
  renderReport(
    [entry({ assetGuid: HERO.path, nodeId: "print" })],
    sources(),
    async () => {
      throw new Error("Read-only during Simulation Play");
    },
  );
  await screen.findByText("Hero");
  fireEvent.click(within(expand("Hero")).getByTestId("session-report-row"));
  expect((await screen.findByTestId("session-report-notice")).textContent).toContain(
    "Read-only during Simulation Play",
  );
});

it("shows an empty report as such when the last session reported nothing", () => {
  renderReport([], sources());
  expect(screen.getByTestId("session-report-empty").textContent).toContain("No Entries");
  expect(screen.getByTestId("session-report-close")).toBeTruthy();
});
