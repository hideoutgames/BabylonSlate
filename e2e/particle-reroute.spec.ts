import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultParticleGraphDocument } from "../packages/particle-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser } from "./open-test-project";

// The knot is checked by eye in these shots, so they are taken at the iPad's pixel ratio.
test.use({ deviceScaleFactor: 2 });

/** Where the review screenshots go besides the test's own output, when the run names a folder. */
const SHOT_DIR = process.env.HAPTIC_E2E_SHOT_DIR;

async function shot(page: Page, name: string, testInfo: TestInfo) {
  const graph = page.getByTestId("particle-graph-editor");
  await graph.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: "disabled" });
  if (SHOT_DIR) await graph.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: "disabled" });
}

test("a double-click on a Particle Graph wire splits it with a Reroute knot and the graph still builds", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const files = await minimalProjectFiles();
  files.set("assets/Knots.particlegraph.hasset", await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000051", type: "ParticleGraph", name: "Knots",
    version: 1, payload: createDefaultParticleGraphDocument("Knots") as unknown as Record<string, unknown>,
  }));
  await openMinimalTestProject(page, files);
  await openAssetFromBrowser(page, "assets/Knots.particlegraph.hasset");
  const graph = page.getByTestId("particle-graph-editor");
  const results = page.getByTestId("particle-graph-compiler-results");
  await expect(graph.locator('.react-flow__node[data-id="output"]')).toBeVisible({ timeout: 15_000 });
  // The default graph has only the missing Material warning.
  await expect(results.locator('[data-testid^="particle-graph-diagnostic-"]')).toHaveCount(1);
  const edges = graph.locator(".react-flow__edge");
  await expect(edges).toHaveCount(8);

  // Double-click the middle of Multiply → Update Color's Color.
  const wire = graph.locator('.react-flow__edge[data-id="e-multiply-color"] path.react-flow__edge-path');
  const point = await wire.evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM()!;
    return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
  });
  await page.mouse.dblclick(point.x, point.y);

  const knot = graph.locator('.react-flow__node:has([data-node-kind="reroute"])');
  await expect(knot).toHaveCount(1);
  const knotId = await knot.getAttribute("data-id");
  await expect(graph.locator('.react-flow__edge[data-id="e-multiply-color"]')).toHaveCount(0);
  await expect(edges).toHaveCount(9);
  await expect(graph.locator(`.react-flow__edge[data-id*="multiply:out:${knotId}:in"]`)).toHaveCount(1);
  await expect(graph.locator(`.react-flow__edge[data-id*="${knotId}:out:updateColor:color"]`)).toHaveCount(1);
  // It builds exactly as before: still only the missing Material warning.
  await expect(results.getByTestId("particle-graph-diagnostic-particle.missingMaterial")).toBeVisible();
  await expect(results.locator('[data-testid^="particle-graph-diagnostic-"]')).toHaveCount(1);
  await shot(page, "particle-knot", testInfo);
});
