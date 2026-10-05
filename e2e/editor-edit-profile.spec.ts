import { expect, test, type Page } from "@playwright/test";
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
 * Env: BL_PERF_EDITS (edits per burst, default 12), BL_PERF_SEARCH (Content
 *      Browser query, default PerfClass1), BL_PERF_QUIET_MS (commit-free time
 *      that ends a measurement, default 750), BL_PERF_LABEL (recorded label).
 *      Unset, non-numeric or out-of-range numeric values use the default.
 */
function envInteger(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

const PROFILING_BUILD = process.env.VITE_REACT_PROFILING === "true";
const EDITS = envInteger("BL_PERF_EDITS", 12, 1);
const SEARCH = process.env.BL_PERF_SEARCH ?? "PerfClass1";
const QUIET_MS = envInteger("BL_PERF_QUIET_MS", 750, 0);
const SETTLE_TIMEOUT_MS = 20_000;
const IDLE_MS = 3_000;
const EXTRA_CLASSES = 64;
const GRAPH_VALUES = 30;
const GRAPH_PRINTS = 6;
const STROKE_CELLS = 8;

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// The minimal project's Main class identity.
const MAIN_CLASS_GUID = guid(2);
const TILESET_GUID = guid(900);
const TILEMAP_GUID = guid(901);
const TILEMAP_FILE = "assets/PerfMap.tilemap.babasset";
const classFile = (index: number) =>
  `assets/PerfClass${String(index).padStart(2, "0")}.class.babasset`;

/** Main Class event graph: Begin Play, a Print chain and a grid of Make Float literals. */
function classGraph(): SerializedGraph {
  const literal = literalNodes.find((entry) => entry.id === "literal.makeFloat")!;
  const nodes: SerializedGraph["nodes"] = [
    { id: "begin", type: "flow.event.beginPlay", position: { x: -320, y: -220 }, data: {} },
  ];
  const edges: SerializedGraph["edges"] = [];
  for (let index = 0; index < GRAPH_VALUES; index += 1) {
    nodes.push({
      id: `value-${index}`,
      type: literal.id,
      position: { x: (index % 6) * 260, y: Math.floor(index / 6) * 160 },
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
      position: { x: index * 260, y: -220 },
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

async function tileAt(page: Page, gx: number, gy: number) {
  return page.evaluate(
    ([x, y]) => (globalThis as unknown as ProfileHost).__babylonslateTest.activeTilemapTile(x, y),
    [gx, gy] as const,
  );
}

test.skip(
  !PROFILING_BUILD,
  "Editor-edit profiling route; build and run with VITE_REACT_PROFILING=true.",
);

test("editor-edit profiling route", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page, await profileProjectFiles());
  await openMainScene(page);
  // The Play performance route's room, installed the same way that route does:
  // its first viewport load needs more than the default scene-ready budget.
  const room = playPerformanceRoom();
  await setPreviewScene(page, room, 120_000);
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true", {
    timeout: 120_000,
  });
  expect(
    await page.evaluate(
      () => (globalThis as unknown as ProfileHost).__babylonslateTest.renderProfile().enabled,
    ),
    "The artifact must be built with VITE_REACT_PROFILING=true so test-mode Profilers mount",
  ).toBe(true);

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
  };

  // Background commits with no input, for scaling the edit windows below.
  await record(
    await measure(page, "idle", "window", 1, () => page.waitForTimeout(IDLE_MS)),
  );

  // (a) Scene Details numeric edits on the active scene.
  await page.getByTestId("tree-row-actor:Floor").click();
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

  // (b) Class graph node data edits (Make Float default in the Details panel).
  await openAssetFromBrowser(page, MAIN_CLASS_FILE);
  await page.locator('.react-flow__node[data-id="value-0"]').click();
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

  // (c) Typing a search into the Content Browser grid.
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  const search = page.getByTestId("content-browser-search");
  await search.fill("");
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

  // (d) One Tilemap brush stroke across a row of cells.
  await openAssetFromBrowser(page, TILEMAP_FILE);
  await expect(page.getByTestId("document-workspace-tilemap")).toBeVisible();
  await page.getByTestId("tilemap-palette-tile-1").click();
  await page.getByTestId("tilemap-tool-brush").click();
  const canvas = page.getByTestId("tilemap-paint-canvas");
  await expect(canvas).toHaveAttribute("data-tool", "brush");
  await expect(canvas).toHaveAttribute("data-gid", "1");
  const cellSize = Number(await canvas.getAttribute("data-cell-size"));
  const box = await canvas.boundingBox();
  expect(cellSize).toBeGreaterThan(0);
  expect(box).toBeTruthy();
  const cell = (index: number) => ({
    x: box!.x + index * cellSize + cellSize / 2,
    y: box!.y + box!.height - cellSize / 2,
  });
  await record(
    await measure(page, "tilemap-paint-stroke", "stroke", 1, async () => {
      await page.mouse.move(cell(0).x, cell(0).y);
      await page.mouse.down();
      for (let index = 1; index < STROKE_CELLS; index += 1) {
        await page.mouse.move(cell(index).x, cell(index).y, { steps: 2 });
      }
      await page.mouse.up();
      await expect.poll(() => tileAt(page, STROKE_CELLS - 1, 0)).toBe(1);
    }),
  );
  expect(await tileAt(page, 0, 0)).toBe(1);

  const report = {
    qualification:
      "React commit counts and Profiler durations per editor edit in a React profiling build on this machine. A comparison aid between revisions, not a device measurement; no thresholds.",
    label: process.env.BL_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    viewportCss: page.viewportSize(),
    fixture: {
      sceneActors: room.actors.length,
      graphNodes: 1 + GRAPH_VALUES + GRAPH_PRINTS,
      extraClasses: EXTRA_CLASSES,
      search: SEARCH,
      strokeCells: STROKE_CELLS,
    },
    quietMs: QUIET_MS,
    pageErrors: errors,
    scenarios: measurements.map(({ profile, ...measurement }) => ({
      ...measurement,
      ...summarize(profile, measurement.edits),
    })),
  };
  await testInfo.attach("editor-edit-profile", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(`[editor-edit-profile] ${JSON.stringify(report)}`);
  for (const measurement of measurements.slice(1)) {
    expect(measurement.profile.commits, measurement.scenario).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});
