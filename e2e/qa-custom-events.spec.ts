import { expect, test, type Page } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";

const CLASS_PATH = "assets/Mannequin.class.hasset";

async function savedGraph(page: Page): Promise<SerializedGraph> {
  return page.evaluate(async (path) => {
    const bytes = await (globalThis as unknown as {
      __hapticTest: { readAssetChunk: (path: string, chunk: string) => Promise<Uint8Array> };
    }).__hapticTest.readAssetChunk(path, "document");
    return JSON.parse(new TextDecoder().decode(bytes));
  }, CLASS_PATH);
}

test("H12/M28: Ping with its created declaration compiles and runs after reload in Normal Play", async ({ page }) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await openAssetFromBrowser(page, CLASS_PATH);
  await page.getByTestId("class-add-events").click();
  await page.getByTestId("add-event-menu").getByTestId("search-item-__new__").click();
  await page.getByRole("textbox", { name: "Rename NewEvent" }).fill("Ping");
  await page.getByRole("textbox", { name: "Rename NewEvent" }).press("Enter");
  await expect(page.getByTestId("add-event-menu")).toHaveCount(0);
  await saveAllIfEnabled(page);
  const authored = await savedGraph(page);
  const event = authored.nodes.find((node) => node.type === "flow.event.custom" && node.data.name === "Ping");
  expect(event).toBeTruthy();
  expect(authored.members).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: event!.id, kind: "event", name: "Ping" }),
  ]));
  const next: SerializedGraph = {
    ...authored,
    nodes: [
      event!,
      { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} },
      { id: "call", type: "flow.event.call", position: { x: 300, y: 0 }, data: { name: "Ping", implicitSelf: true, pins: [] } },
      { id: "print", type: "debug.print", position: { x: 300, y: 180 }, data: { "default:value": "PING_CALLED", "default:key": "ping", "default:duration": 30 } },
    ],
    edges: [
      { id: "begin-call", source: "begin", sourceHandle: "execOut", target: "call", targetHandle: "execIn" },
      { id: "ping-print", source: event!.id, sourceHandle: "execOut", target: "print", targetHandle: "execIn" },
    ],
  };
  expect(await page.evaluate((graph) => (globalThis as unknown as {
    __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> };
  }).__hapticTest.setMainGraphContent(graph), next)).toBe(true);
  await page.getByTestId("compile-graph").click();
  await expect(page.getByTestId("compile-graph")).toBeDisabled();
  await expect(page.getByTestId("compilation-error")).toHaveCount(0);
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  expect((await savedGraph(page)).members).toEqual(authored.members);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText("PING_CALLED", { timeout: 30_000 });
  await page.getByTestId("play-overlay-close").click();
});
