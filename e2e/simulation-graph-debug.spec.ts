import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedGraph,
} from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";

type TestHost = typeof globalThis & {
  __hapticSimulationTest: { start(): Promise<void>; state(): { lifecycle: string } };
  __hapticPlayTest: { tickIndex(): number };
  __hapticTest: { setMainGraphContent(graph: SerializedGraph): Promise<boolean> };
};

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0) =>
  ({ id, type, position: { x, y }, data });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id: `${source}.${sourceHandle}>${target}.${targetHandle}`, source, sourceHandle, target, targetHandle });

/**
 * Event Tick runs a Branch on the instance's name. Beta takes True (Print A, fed by a pure Add) and
 * Alpha takes False (Print B, fed by a pure Get Actor Location), so what lights up tells the two
 * instances apart.
 */
const CLASS_GRAPH = {
  nodes: [
    node("tick", "flow.event.tick", {}, 0, 0),
    node("branch", "flow.branch", {}, 380, 0),
    node("self", "actor.getSelf", {}, -380, 420),
    node("name", "actor.getName", {}, 0, 420),
    node("isBeta", "string.equals", { "default:b": "Beta" }, 380, 420),
    node("addA", "math.add", { "default:a": 1.23456789, "default:b": 1 }, 380, 220),
    node("printA", "debug.print", { "default:key": "a", "default:duration": 0.1 }, 820, 0),
    node("loc", "transform.getLocation", {}, 380, 640),
    node("printB", "debug.print", { "default:key": "b", "default:duration": 0.1 }, 820, 520),
  ],
  edges: [
    wire("tick", "execOut", "branch", "execIn"),
    wire("self", "out", "name", "target"),
    wire("self", "out", "loc", "target"),
    wire("name", "out", "isBeta", "a"),
    wire("isBeta", "out", "branch", "condition"),
    wire("branch", "true", "printA", "execIn"),
    wire("branch", "false", "printB", "execIn"),
    wire("addA", "out", "printA", "value"),
    wire("loc", "out", "printB", "value"),
  ],
} as unknown as SerializedGraph;

const select = (page: Page) => page.getByTestId("graph-debug-instance-select");
const graphPanel = (page: Page) => page.getByTestId("graph-panel");
const pinSide = (page: Page, nodeId: string, pinId: string) =>
  graphPanel(page).locator(`.react-flow__node[data-id="${nodeId}"] [data-pin-side="in"][data-pin-id="${pinId}"]`);

async function focusClassGraph(page: Page) {
  await page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByTestId("document-tab-select").click();
  await expect(graphPanel(page).locator('.react-flow__node[data-id="printB"]')).toBeVisible({ timeout: 15_000 });
}

async function startSimulation(page: Page) {
  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => (globalThis as TestHost).__hapticPlayTest.tickIndex()), { timeout: 30_000 })
    .toBeGreaterThan(2);
}

type Flashed = {
  nodes: string[];
  wires: string[];
  /** Every flash animation lasts this long, in ms. */
  durations: number[];
  /** Whether each node's animation keeps one look from start to end (a static highlight). */
  staticNodes: boolean;
  /** Whether a wire's animation starts from the flash colour (offset 0) and ends on its own paint. */
  wiresStartHighlighted: boolean;
};

/** What the canvas animates over `ms`: the Web Animations on node shells and wire paths, by id. */
async function flashedDuring(page: Page, ms: number): Promise<Flashed> {
  return page.evaluate(async (window) => {
    const nodes = new Set<string>();
    const wires = new Set<string>();
    const durations = new Set<number>();
    let staticNodes = true;
    let wiresStartHighlighted = true;
    const started = performance.now();
    while (performance.now() - started < window) {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        const target = effect?.target;
        if (!(target instanceof Element) || !target.closest(".react-flow")) continue;
        const frames = effect!.getKeyframes();
        const node = target.matches("[data-node-role]") ? target.closest(".react-flow__node")?.getAttribute("data-id") : null;
        const edge = target.matches(".react-flow__edge-path") ? target.closest(".react-flow__edge")?.getAttribute("data-id") : null;
        if (node) {
          nodes.add(node);
          durations.add(Number(effect!.getTiming().duration));
          const first = frames[0] as Record<string, unknown>;
          const last = frames.at(-1) as Record<string, unknown>;
          if (first.outlineColor !== last.outlineColor) staticNodes = false;
        } else if (edge) {
          wires.add(edge);
          durations.add(Number(effect!.getTiming().duration));
          // A lone keyframe at offset 1 would fade the wire towards the flash colour instead of away from it.
          if (frames[0]!.computedOffset !== 0) wiresStartHighlighted = false;
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { nodes: [...nodes].sort(), wires: [...wires].sort(), durations: [...durations], staticNodes, wiresStartHighlighted };
  }, ms);
}

const liveFlashes = (page: Page) =>
  page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.(".react-flow")).length);

async function pickInstance(page: Page, name: string) {
  await select(page).click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(select(page)).toContainText(name);
}

/** The pin tip while hovering a pin, and where it sits relative to the pin and the window. */
async function hoverPinTip(page: Page, nodeId: string, pinId: string) {
  const side = pinSide(page, nodeId, pinId);
  await side.hover();
  const tip = page.getByTestId("graph-pin-value-tip");
  await expect(tip).toBeVisible();
  const [tipBox, pinBox] = [await tip.boundingBox(), await side.boundingBox()];
  const viewport = page.viewportSize()!;
  expect(tipBox).not.toBeNull();
  expect(pinBox).not.toBeNull();
  // On screen, centred over the pin and just above it.
  expect(tipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tipBox!.y).toBeGreaterThanOrEqual(0);
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(Math.abs(tipBox!.x + tipBox!.width / 2 - (pinBox!.x + pinBox!.width / 2))).toBeLessThan(8);
  const gap = pinBox!.y - (tipBox!.y + tipBox!.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(24);
  return tip.innerText();
}

test("a Simulation lights up what a Class graph runs for the chosen instance and shows pin values", async ({ page }) => {
  test.setTimeout(240_000);
  await openMinimalTestProject(page);
  await openMainScene(page);
  expect(await page.evaluate((graph) => (globalThis as TestHost).__hapticTest.setMainGraphContent(graph), CLASS_GRAPH)).toBe(true);
  const scene = createDefaultScene();
  scene.actors = [
    ...scene.actors.filter((actor) => actor.classId !== "main"),
    ...(["Alpha", "Beta"] as const).map((name, index) => createActor(name.toLowerCase(), name, {
      classId: "main",
      transform: { ...identitySerializedTransform(), position: [index * 10 - 5, 0, 0] },
      components: [createMeshComponent(`${name.toLowerCase()}-mesh`, "box")],
    })),
  ];
  await setPreviewScene(page, scene);

  // A Play before the Simulation leaves its compiled scripts cached; the Simulation must still run its own, with probes.
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText(/\d/, { timeout: 30_000 });
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);

  // Plain editing: no instance select, no pin tip.
  await focusClassGraph(page);
  await expect(select(page)).toHaveCount(0);
  await pinSide(page, "printB", "value").hover();
  await expect(page.getByTestId("graph-pin-value-tip")).toHaveCount(0);

  // A Simulation opens on its Scene; the select belongs to the Class graph in focus.
  await startSimulation(page);
  await expect(select(page)).toHaveCount(0);
  await focusClassGraph(page);
  await expect(select(page)).toBeVisible();
  // The first instance is followed by default, and both are listed by name.
  await expect(select(page)).toContainText("Alpha");
  await select(page).click();
  await expect(page.getByRole("option")).toHaveText(["None", "Alpha", "Beta"]);
  await page.keyboard.press("Escape");

  // Alpha takes the False branch: Event Tick, Branch and Print B light up, nothing else.
  await expect
    .poll(async () => (await flashedDuring(page, 500)).nodes, { timeout: 30_000 })
    .toEqual(["branch", "printB", "tick"]);
  const alpha = await flashedDuring(page, 500);
  expect(alpha.wires).toEqual(expect.arrayContaining([
    "tick.execOut>branch.execIn",
    "branch.false>printB.execIn",
    "isBeta.out>branch.condition",
    "loc.out>printB.value",
  ]));
  expect(alpha.wires).not.toContain("branch.true>printA.execIn");
  expect(alpha.wires).not.toContain("addA.out>printA.value");
  expect(alpha.durations).toEqual([250]);
  expect(alpha.staticNodes).toBe(false);
  expect(alpha.wiresStartHighlighted).toBe(true);

  // Pin values: the last value, rounded; and nothing for a pin that has not run.
  expect(await hoverPinTip(page, "printB", "value")).toBe("{x: -5, y: 0, z: 0}");
  expect(await hoverPinTip(page, "printA", "value")).toBe("No value yet");
  await page.mouse.move(0, 0);
  await expect(page.getByTestId("graph-pin-value-tip")).toHaveCount(0);

  // Beta takes the True branch, and Alpha's nodes stop lighting up.
  await pickInstance(page, "Beta");
  await expect
    .poll(async () => (await flashedDuring(page, 500)).nodes, { timeout: 30_000 })
    .toEqual(["branch", "printA", "tick"]);
  await expect.poll(() => hoverPinTip(page, "printA", "value"), { timeout: 15_000 }).toBe("2.2346");

  // Reduced motion holds the highlight instead of fading it.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(async () => {
      const flashed = await flashedDuring(page, 500);
      return flashed.nodes.length === 3 && flashed.staticNodes;
    }, { timeout: 15_000 })
    .toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Nothing runs while paused, so every highlight clears.
  await page.getByTestId("simulation-pause").click();
  await expect(page.getByTestId("simulation-pause")).toHaveAccessibleName("Resume");
  await expect.poll(() => liveFlashes(page), { timeout: 10_000 }).toBe(0);

  // Stopping removes the select and the tips.
  await page.getByTestId("simulation-session-stop").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 30_000 });
  await expect(select(page)).toHaveCount(0);
  await pinSide(page, "printB", "value").hover();
  await expect(page.getByTestId("graph-pin-value-tip")).toHaveCount(0);
});

test("a Class graph first opened during a Simulation does not make Stop report a texture leak", async ({ page }) => {
  test.setTimeout(120_000);
  const textureLeaks: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /^\[play\] \d+ texture\(s\)/.test(message.text())) textureLeaks.push(message.text());
  });
  await openMinimalTestProject(page);
  await openMainScene(page);
  expect(await page.evaluate((graph) => (globalThis as TestHost).__hapticTest.setMainGraphContent(graph), CLASS_GRAPH)).toBe(true);

  // The Class graph's viewport draws on the Simulation's Engine and creates its own textures after the Simulation began.
  await startSimulation(page);
  await focusClassGraph(page);
  await page.getByTestId("simulation-session-stop").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 30_000 });

  // The session owner goes idle only after the leak check has run.
  await expect
    .poll(() => page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.state().lifecycle), { timeout: 30_000 })
    .toBe("idle");
  expect(textureLeaks).toEqual([]);
});
