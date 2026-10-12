import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type {
  SessionReportAsset,
  SessionReportLocationSources,
} from "../lib/session-report-locations";
import { PreviewSessionReport } from "./preview-session-report";

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
  onNavigate = vi.fn(),
) {
  render(
    <PreviewSessionReport
      open
      entries={entries}
      dropped={0}
      onOpenChange={() => undefined}
      onNavigate={onNavigate}
      locationSources={locationSources}
    />,
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
  expect(within(expand("missing-guid")).getByTestId("session-report-row").textContent).toContain(
    "missing-guid › n1",
  );
  expect(within(expand("Unknown Asset")).getByTestId("session-report-row").textContent).toContain(
    "Unknown Asset › orphan",
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
