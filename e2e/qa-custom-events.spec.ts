import { expect, test, type Page } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { saveAllIfEnabled } from "./save-all";

const CLASS_PATH = "assets/Mannequin.class.babasset";

async function savedGraph(page: Page): Promise<SerializedGraph> {
  return page.evaluate(async (path) => {
    const bytes = await (globalThis as unknown as {
      __babylonslateTest: { readAssetChunk: (path: string, chunk: string) => Promise<Uint8Array> };
    }).__babylonslateTest.readAssetChunk(path, "document");
    return JSON.parse(new TextDecoder().decode(bytes));
  }, CLASS_PATH);
}

for (const preview of [false, true]) {
  for (const legacy of [false, true]) {
  test(`H12/M28: Ping ${legacy ? "without member metadata" : "with its created declaration"} compiles and runs after reload in ${preview ? "Preview Build" : "Normal Play"}`, async ({ page }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    await openAssetFromBrowser(page, CLASS_PATH);
    await page.getByTestId("class-add-events").click();
    await page.getByTestId("add-event-name").fill("Ping");
    await page.getByTestId("add-event-confirm").click();
    await expect(page.getByTestId("add-event-dialog")).toHaveCount(0);
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
        { id: "print", type: "debug.print", position: { x: 300, y: 180 }, data: { value: "PING_CALLED", key: "ping", duration: 30 } },
      ],
      edges: [
        { id: "begin-call", source: "begin", sourceHandle: "execOut", target: "call", targetHandle: "execIn" },
        { id: "ping-print", source: event!.id, sourceHandle: "execOut", target: "print", targetHandle: "execIn" },
      ],
    };
    if (legacy) delete next.members;
    expect(await page.evaluate((graph) => (globalThis as unknown as {
      __babylonslateTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> };
    }).__babylonslateTest.setMainGraphContent(graph), next)).toBe(true);
    await page.getByTestId("compile-graph").click();
    await expect(page.getByTestId("compile-graph")).toBeDisabled();
    await expect(page.getByTestId("compilation-error")).toHaveCount(0);
    await saveAllIfEnabled(page);
    await page.reload();
    await openTestProject(page);
    expect((await savedGraph(page)).members).toEqual(legacy ? undefined : authored.members);
    await openMainScene(page);
    if (preview) {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    } else await clickPlayAndWaitForOverlay(page);
    const prints = preview
      ? page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("print-overlay")
      : page.getByTestId("print-overlay");
    await expect(prints).toContainText("PING_CALLED", { timeout: 30_000 });
    await page.getByTestId(preview ? "preview-build-close" : "play-overlay-close").click();
  });
  }
}
