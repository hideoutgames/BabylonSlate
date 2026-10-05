import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createMeshComponent,
  MAIN_CLASS_FILE,
  type SerializedGraph,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultTilemapPayload } from "../packages/assets/src/tilemap-payload";
import {
  createDefaultTilesetPayload,
  ensureTilesetTiles,
} from "../packages/assets/src/tileset-payload";
import { literalNodes } from "../packages/scripting-nodes/src/literal.ts";
import type { RenderProfile } from "../apps/editor/src/lib/render-profile";
import { openMinimalTestProject } from "./minimal-project";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { playPerformanceRoom } from "./play-performance-fixture";
import { setPreviewScene } from "./preview-parity";

/**
 * Local editor-edit profiling route. Opt-in: the test artifact must be built
 * with VITE_REACT_PROFILING=true, which selects React's profiling renderer and
 * mounts the test-mode Profiler regions (`editor-route`, `editor-layout`,
 * `editor-chrome-bar`, `document-workspace`, `editor-status-bar`,
 * `document:<id>`, `panel:<component>`). Each scenario resets
 * `__babylonslateTest.renderProfile()`, performs a burst of real edits, waits
 * for commits to settle, and attaches per-region commit counts and Profiler
 * durations. It asserts only that the edits applied; it never asserts timing.
 *
 * Env: BL_PERF_SCENARIOS (comma-separated subset of idle, scene, graph,
 *      content-browser, tilemap; default all, always run in that order),
 *      BL_PERF_EDITS (edits per burst, default 12), BL_PERF_SEARCH (Content
 *      Browser query, default PerfClass1), BL_PERF_QUIET_MS (commit-free time
 *      that ends a measurement, default 750), BL_PERF_LABEL (recorded label).
 *      Unset, non-numeric or out-of-range numeric values use the default; an
 *      unknown scenario name fails the run before the project opens.
 */
function envInteger(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

/** Scenario ids accepted by BL_PERF_SCENARIOS, in run order. */
const SCENARIO_IDS = ["idle", "scene", "graph", "content-browser", "tilemap"] as const;
type ScenarioId = (typeof SCENARIO_IDS)[number];

function scenarioSelection(raw: string | undefined) {
  const requested = (raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const known = new Set<string>(SCENARIO_IDS);
  return {
    selected:
      requested.length === 0
        ? [...SCENARIO_IDS]
        : SCENARIO_IDS.filter((id) => requested.includes(id)),
    unknown: requested.filter((name) => !known.has(name)),
  };
}

const PROFILING_BUILD = process.env.VITE_REACT_PROFILING === "true";
const SCENARIOS = scenarioSelection(process.env.BL_PERF_SCENARIOS);
const EDITS = envInteger("BL_PERF_EDITS", 12, 1);
const SEARCH = process.env.BL_PERF_SEARCH ?? "PerfClass1";
const QUIET_MS = envInteger("BL_PERF_QUIET_MS", 750, 0);
const SETTLE_TIMEOUT_MS = 20_000;
// Opening the project and loading the Play performance room (two 120 s waits).
const SETUP_TIMEOUT_MS = 300_000;
// Preparation plus one measured window: two settles of at most 20 s each and a burst.
const SCENARIO_TIMEOUT_MS = 120_000;
// A blocked click or fill reports its cause well inside the scenario budget.
const ACTION_TIMEOUT_MS = 15_000;
// Opening a document lazily mounts its editor, which a loaded machine can stretch.
const DOCUMENT_OPEN_TIMEOUT_MS = 30_000;
const IDLE_MS = 3_000;
const EXTRA_CLASSES = 64;
const GRAPH_VALUES = 30;
const GRAPH_PRINTS = 6;
const GRAPH_NODES = 1 + GRAPH_VALUES + GRAPH_PRINTS;
// Node cards are at least 320 px wide; a Print card (five pin rows) is about
// 300 px tall and a Make Float card about 100 px. These pitches keep every card
// clear of its neighbours, so no node covers another node's click target.
const GRAPH_COLUMN_PITCH = 420;
const GRAPH_VALUES_TOP = 420;
const GRAPH_VALUE_ROW_PITCH = 160;
const STROKE_CELLS = 8;

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// The minimal project's Main class identity.
const MAIN_CLASS_GUID = guid(2);
const TILESET_GUID = guid(900);
const TILEMAP_GUID = guid(901);
const TILEMAP_FILE = "assets/PerfMap.tilemap.babasset";
const classFile = (index: number) =>
  `assets/PerfClass${String(index).padStart(2, "0")}.class.babasset`;

/**
 * Main Class event graph: Begin Play and a row of Print nodes above a 6 x 5
 * grid of Make Float literals. No two node cards overlap.
 */
function classGraph(): SerializedGraph {
  const literal = literalNodes.find((entry) => entry.id === "literal.makeFloat")!;
  const nodes: SerializedGraph["nodes"] = [
    {
      id: "begin",
      type: "flow.event.beginPlay",
      position: { x: -GRAPH_COLUMN_PITCH, y: 0 },
      data: {},
    },
  ];
  const edges: SerializedGraph["edges"] = [];
  for (let index = 0; index < GRAPH_VALUES; index += 1) {
    nodes.push({
      id: `value-${index}`,
      type: literal.id,
      position: {
        x: (index % 6) * GRAPH_COLUMN_PITCH,
        y: GRAPH_VALUES_TOP + Math.floor(index / 6) * GRAPH_VALUE_ROW_PITCH,
      },
      data: {
        title: literal.title,
        __nodeType: literal.id,
        __pins: literal.pins({}),
        "default:in": index,
      },
    });
  }
  for (let index = 0; index < GRAPH_PRINTS; index += 1) {
    nodes.push({
      id: `print-${index}`,
      type: "debug.print",
      position: { x: index * GRAPH_COLUMN_PITCH, y: 0 },
      data: { key: `value-${index}`, duration: 30 },
    });
    edges.push(
      {
        id: `exec-${index}`,
        source: index === 0 ? "begin" : `print-${index - 1}`,
        sourceHandle: "execOut",
        target: `print-${index}`,
        targetHandle: "execIn",
      },
      {
        id: `value-edge-${index}`,
        source: `value-${index}`,
        sourceHandle: "out",
        target: `print-${index}`,
        targetHandle: "value",
      },
    );
  }
  return {
    nodes,
    edges,
    members: [],
    components: [createMeshComponent("prefab-mesh", "box")],
  };
}

/**
 * The minimal project with a populated Main Class graph, 64 extra Classes for
 * the Content Browser, and a texture-free Tileset plus Tilemap for one paint
 * stroke. All authored JSON; the Main scene becomes the Play performance room
 * after the editor opens.
 */
async function profileProjectFiles() {
  const migrations = createDefaultMigrationRegistry();
  const files = new Map(await minimalProjectFiles());
  files.set(
    MAIN_CLASS_FILE,
    await encodeAssetDocument(
      {
        guid: MAIN_CLASS_GUID,
        type: "Class",
        name: "Main",
        version: migrations.currentVersion("Class"),
        payload: classGraph() as unknown as Record<string, unknown>,
      },
      { parentClass: "Actor" },
    ),
  );
  for (let index = 1; index <= EXTRA_CLASSES; index += 1) {
    const path = classFile(index);
    files.set(
      path,
      await encodeAssetDocument(
        {
          guid: guid(1000 + index),
          type: "Class",
          name: path.slice("assets/".length, -".class.babasset".length),
          version: migrations.currentVersion("Class"),
          payload: { nodes: [], edges: [], members: [], components: [] },
        },
        { parentClass: "Actor" },
      ),
    );
  }
  const tileset = ensureTilesetTiles({ ...createDefaultTilesetPayload(), atlasWidth: 64 });
  files.set(
    "assets/PerfTiles.tileset.babasset",
    await encodeAssetDocument({
      guid: TILESET_GUID,
      type: "Tileset",
      name: "PerfTiles",
      version: migrations.currentVersion("Tileset"),
      payload: tileset as unknown as Record<string, unknown>,
    }),
  );
  const tilemap = {
    ...createDefaultTilemapPayload(),
    tilesetGuid: TILESET_GUID,
    tilesets: [{ guid: TILESET_GUID, firstGid: 1, tileCount: tileset.tiles.length }],
  };
  files.set(
    TILEMAP_FILE,
    await encodeAssetDocument(
      {
        guid: TILEMAP_GUID,
        type: "Tilemap",
        name: "PerfMap",
        version: migrations.currentVersion("Tilemap"),
        payload: tilemap as unknown as Record<string, unknown>,
      },
      { dependencies: [TILESET_GUID] },
    ),
  );
  return files;
}

type ProfileHost = {
  __babylonslateTest: {
    renderProfile: () => RenderProfile;
    resetRenderProfile: () => void;
    activeSceneContent: () => SerializedScene | null;
    activeTilemapTile: (gx: number, gy: number) => number | null;
  };
};

/** Wait until no profiled React commit lands for `quietMs`, so trailing work is counted. */
async function settle(page: Page) {
  return page.evaluate(
    async ({ quietMs, timeoutMs }) => {
      const host = (globalThis as unknown as ProfileHost).__babylonslateTest;
      const started = performance.now();
      let last = host.renderProfile().commits;
      let quietSince = started;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const now = performance.now();
        const commits = host.renderProfile().commits;
        if (commits !== last) {
          last = commits;
          quietSince = now;
        } else if (now - quietSince >= quietMs) {
          return { settled: true, waitedMs: now - started };
        }
        if (now - started >= timeoutMs) return { settled: false, waitedMs: now - started };
      }
    },
    { quietMs: QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS },
  );
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function summarize(profile: RenderProfile, edits: number) {
  return {
    commits: profile.commits,
    commitsPerEdit: round(profile.commits / edits),
    regions: Object.entries(profile.regions)
      .map(([region, totals]) => ({
        region,
        commits: totals.commits,
        commitsPerEdit: round(totals.commits / edits),
        mounts: totals.mounts,
        updates: totals.updates,
        nestedUpdates: totals.nestedUpdates,
        actualMs: round(totals.actualMs),
        actualMsPerEdit: round(totals.actualMs / edits),
        baseMs: round(totals.baseMs),
        maxActualMs: round(totals.maxActualMs),
      }))
      .sort((a, b) => b.actualMs - a.actualMs || a.region.localeCompare(b.region)),
  };
}

type Measurement = Awaited<ReturnType<typeof measure>>;

/** Reset the profile, run `action`, let commits settle, and return the window's totals. */
async function measure(
  page: Page,
  scenario: string,
  unit: string,
  edits: number,
  action: () => Promise<void>,
) {
  const before = await settle(page);
  const startedAt = await page.evaluate(() => {
    (globalThis as unknown as ProfileHost).__babylonslateTest.resetRenderProfile();
    return performance.now();
  });
  const actionStarted = Date.now();
  await action();
  const actionMs = Date.now() - actionStarted;
  const after = await settle(page);
  const { profile, endedAt } = await page.evaluate(() => ({
    profile: (globalThis as unknown as ProfileHost).__babylonslateTest.renderProfile(),
    endedAt: performance.now(),
  }));
  return {
    scenario,
    unit,
    edits,
    actionMs,
    windowMs: round(endedAt - startedAt),
    settledBefore: before.settled,
    settle: { settled: after.settled, waitedMs: round(after.waitedMs) },
    profile,
  };
}

/** One scenario's report entry: the window's metadata plus its per-region summary. */
function scenarioSummary({ profile, ...measurement }: Measurement) {
  return { ...measurement, ...summarize(profile, measurement.edits) };
}

async function tileAt(page: Page, gx: number, gy: number) {
  return page.evaluate(
    ([x, y]) => (globalThis as unknown as ProfileHost).__babylonslateTest.activeTilemapTile(x, y),
    [gx, gy] as const,
  );
}

/** Mounted node cards in the graph that contains `node`, and every overlapping pair. */
async function graphLayout(node: Locator) {
  return node.evaluate((element) => {
    const flow: ParentNode = element.closest(".react-flow") ?? document;
    const cards = [...flow.querySelectorAll<HTMLElement>(".react-flow__node")].map((card) => ({
      id: card.dataset.id ?? "",
      rect: card.getBoundingClientRect(),
    }));
    const overlaps: string[] = [];
    cards.forEach((a, index) => {
      for (const b of cards.slice(index + 1)) {
        if (
          a.rect.left < b.rect.right &&
          b.rect.left < a.rect.right &&
          a.rect.top < b.rect.bottom &&
          b.rect.top < a.rect.bottom
        ) {
          overlaps.push(`${a.id} / ${b.id}`);
        }
      }
    });
    return { nodes: cards.length, overlaps };
  });
}

test.skip(
  !PROFILING_BUILD,
  "Editor-edit profiling route; build and run with VITE_REACT_PROFILING=true.",
);

test("editor-edit profiling route", async ({ page }, testInfo) => {
  expect(
    SCENARIOS.unknown,
    `BL_PERF_SCENARIOS accepts a comma-separated subset of ${SCENARIO_IDS.join(", ")}`,
  ).toEqual([]);
  test.setTimeout(SETUP_TIMEOUT_MS + SCENARIOS.selected.length * SCENARIO_TIMEOUT_MS + 60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The Play performance route's room, installed the same way that route does:
  // its first viewport load needs more than the default scene-ready budget.
  // Every selection opens the same project and room, so a scenario's window is
  // comparable whether it ran alone or with the others.
  const room = playPerformanceRoom();
  await test.step(
    "open the profiling project",
    async () => {
      await openMinimalTestProject(page, await profileProjectFiles());
      await openMainScene(page);
      await setPreviewScene(page, room, 120_000);
      await expect(page.getByTestId("viewport-panel")).toHaveAttribute(
        "data-scene-ready",
        "true",
        { timeout: 120_000 },
      );
      expect(
        await page.evaluate(
          () => (globalThis as unknown as ProfileHost).__babylonslateTest.renderProfile().enabled,
        ),
        "The artifact must be built with VITE_REACT_PROFILING=true so test-mode Profilers mount",
      ).toBe(true);
    },
    { timeout: SETUP_TIMEOUT_MS },
  );

  const measurements: Measurement[] = [];
  const record = async (measurement: Measurement) => {
    measurements.push(measurement);
    await testInfo.attach(`editor-edit-profile-${measurement.scenario}`, {
      body: JSON.stringify(
        { ...measurement, summary: summarize(measurement.profile, measurement.edits) },
        null,
        2,
      ),
      contentType: "application/json",
    });
    // The next invocation replaces Playwright's report; the log line keeps this window.
    console.log(
      `[editor-edit-profile:${measurement.scenario}] ${JSON.stringify(scenarioSummary(measurement))}`,
    );
  };

  const scenarios: Record<ScenarioId, () => Promise<void>> = {
    // Background commits with no input, for scaling the edit windows.
    idle: async () => {
      await record(
        await measure(page, "idle", "window", 1, () => page.waitForTimeout(IDLE_MS)),
      );
    },

    // Scene Details numeric edits on the active scene.
    scene: async () => {
      await page.getByTestId("tree-row-actor:Floor").click({ timeout: ACTION_TIMEOUT_MS });
      const positionX = page.getByTestId("property-actor-position-x");
      await expect(positionX).toBeVisible();
      const sceneValues = Array.from({ length: EDITS }, (_, index) => String((index + 1) * 0.5));
      await record(
        await measure(page, "scene-details-numeric", "edit", EDITS, async () => {
          for (const value of sceneValues) {
            await positionX.fill(value);
            await positionX.press("Tab");
            await expect(positionX).toHaveValue(value);
          }
        }),
      );
      const floorX = await page.evaluate(
        () =>
          (globalThis as unknown as ProfileHost).__babylonslateTest
            .activeSceneContent()
            ?.actors.find((actor) => actor.id === "Floor")?.transform.position[0] ?? null,
      );
      expect(floorX).toBe(Number(sceneValues.at(-1)));
    },

    // Class graph node data edits (Make Float default in the Details panel).
    graph: async () => {
      await openAssetFromBrowser(page, MAIN_CLASS_FILE);
      const valueNode = page.locator('.react-flow__node[data-id="value-0"]');
      await expect(valueNode).toBeVisible({ timeout: DOCUMENT_OPEN_TIMEOUT_MS });
      // The measured graph is every card mounted with none covering another;
      // a card over value-0 would intercept the selection click.
      await expect
        .poll(() => graphLayout(valueNode), {
          message: "Main Class fixture graph: every node mounted and no cards overlapping",
          timeout: ACTION_TIMEOUT_MS,
        })
        .toEqual({ nodes: GRAPH_NODES, overlaps: [] });
      await valueNode.click({ timeout: ACTION_TIMEOUT_MS });
      const literalInput = page.getByTestId("inspector-pin-defaults").getByTestId("property-in");
      await expect(literalInput).toBeVisible();
      const graphValues = Array.from({ length: EDITS }, (_, index) => String(100 + index));
      await record(
        await measure(page, "class-graph-node-data", "edit", EDITS, async () => {
          for (const value of graphValues) {
            await literalInput.fill(value);
            await literalInput.press("Tab");
            await expect(literalInput).toHaveValue(value);
          }
        }),
      );
    },

    // Typing a search into the Content Browser grid.
    "content-browser": async () => {
      await openContentBrowser(page);
      await selectContentBrowserAssetsFolder(page);
      const search = page.getByTestId("content-browser-search");
      await search.fill("", { timeout: ACTION_TIMEOUT_MS });
      await record(
        await measure(page, "content-browser-search", "keystroke", SEARCH.length, async () => {
          await search.pressSequentially(SEARCH, { delay: 60 });
          await expect(search).toHaveValue(SEARCH);
        }),
      );
      if (SEARCH === "PerfClass1") {
        await expect(page.locator(`[data-asset-path="${classFile(15)}"]`)).toBeVisible();
        await expect(page.locator(`[data-asset-path="${classFile(25)}"]`)).toHaveCount(0);
      }
    },

    // One Tilemap brush stroke across a row of cells.
    tilemap: async () => {
      await openAssetFromBrowser(page, TILEMAP_FILE);
      await expect(page.getByTestId("document-workspace-tilemap")).toBeVisible({
        timeout: DOCUMENT_OPEN_TIMEOUT_MS,
      });
      await page.getByTestId("tilemap-palette-tile-1").click({ timeout: ACTION_TIMEOUT_MS });
      await page.getByTestId("tilemap-tool-brush").click({ timeout: ACTION_TIMEOUT_MS });
      const canvas = page.getByTestId("tilemap-paint-canvas");
      await expect(canvas).toHaveAttribute("data-tool", "brush");
      await expect(canvas).toHaveAttribute("data-gid", "1");
      const cellSize = Number(await canvas.getAttribute("data-cell-size"));
      const box = await canvas.boundingBox();
      expect(cellSize).toBeGreaterThan(0);
      expect(box).toBeTruthy();
      // Bottom-row cell centres, relative to the canvas.
      const cell = (index: number) => ({
        x: index * cellSize + cellSize / 2,
        y: box!.height - cellSize / 2,
      });
      // page.mouse skips hit testing: first check that both ends of the stroke
      // reach the canvas rather than an element over it.
      for (const index of [0, STROKE_CELLS - 1]) {
        await canvas.click({ position: cell(index), trial: true, timeout: ACTION_TIMEOUT_MS });
      }
      const at = (index: number) => ({ x: box!.x + cell(index).x, y: box!.y + cell(index).y });
      await record(
        await measure(page, "tilemap-paint-stroke", "stroke", 1, async () => {
          await page.mouse.move(at(0).x, at(0).y);
          await page.mouse.down();
          for (let index = 1; index < STROKE_CELLS; index += 1) {
            await page.mouse.move(at(index).x, at(index).y, { steps: 2 });
          }
          await page.mouse.up();
          await expect.poll(() => tileAt(page, STROKE_CELLS - 1, 0)).toBe(1);
        }),
      );
      expect(await tileAt(page, 0, 0)).toBe(1);
    },
  };

  for (const id of SCENARIOS.selected) {
    await test.step(`scenario: ${id}`, scenarios[id], { timeout: SCENARIO_TIMEOUT_MS });
  }

  const report = {
    qualification:
      "React commit counts and Profiler durations per editor edit in a React profiling build on this machine. A comparison aid between revisions, not a device measurement; no thresholds.",
    label: process.env.BL_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    viewportCss: page.viewportSize(),
    selectedScenarios: SCENARIOS.selected,
    fixture: {
      sceneActors: room.actors.length,
      graphNodes: GRAPH_NODES,
      extraClasses: EXTRA_CLASSES,
      search: SEARCH,
      strokeCells: STROKE_CELLS,
    },
    quietMs: QUIET_MS,
    pageErrors: errors,
    scenarios: measurements.map(scenarioSummary),
  };
  await testInfo.attach("editor-edit-profile", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(`[editor-edit-profile] ${JSON.stringify(report)}`);
  for (const measurement of measurements.filter(({ scenario }) => scenario !== "idle")) {
    expect(measurement.profile.commits, measurement.scenario).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});
