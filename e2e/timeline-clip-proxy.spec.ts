import { expect, test, type Page } from "@playwright/test";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { encodeRgbaPng } from "../packages/render/src/png-encode";
import { createDefaultTimelineClipAsset, timelineClipAssetSummaries } from "../packages/core/src/timeline-clip-assets";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, waitForEditorInteractive } from "./open-test-project";

type Box = { center: number[]; size: number[] };
type ClipPreviewTest = {
  proxyPositions(): Record<string, { root: number[] | null; visual: number[] | null }>;
  setPlayhead(time: number): void;
  nudgeProxy(actorId: string, dx: number, dy: number, dz: number, scale?: number): boolean;
  overlayBox(): Box | null;
  proxyBounds(actorId: string): Box | null;
};
const host = "__hapticClipPreviewTest";
/** Where a proxy's mesh stands in the clip asset Viewport, rounded. */
const positionOf = (page: Page, actorId: string) => page.evaluate(({ host, actorId }) => {
  const root = (globalThis as unknown as Record<string, ClipPreviewTest | undefined>)[host]?.proxyPositions()[actorId]?.root;
  return root ? root.map((value) => Math.round(value * 100) / 100 + 0) : null;
}, { host, actorId });
const setPlayhead = (page: Page, time: number) => page.evaluate(({ host, time }) =>
  (globalThis as unknown as Record<string, ClipPreviewTest>)[host]!.setPlayhead(time), { host, time });
const nudge = (page: Page, actorId: string, delta: [number, number, number], scale = 1) => page.evaluate(({ host, actorId, delta, scale }) =>
  (globalThis as unknown as Record<string, ClipPreviewTest>)[host]!.nudgeProxy(actorId, ...delta, scale), { host, actorId, delta, scale });
const rounded = (box: Box | null) => box && { center: box.center.map((value) => Math.round(value * 100) / 100 + 0), size: box.size.map((value) => Math.round(value * 100) / 100 + 0) };
/** The 2D transform box and the proxy it frames, rounded. */
const framing = (page: Page, actorId: string) => page.evaluate(({ host, actorId }) => {
  const test = (globalThis as unknown as Record<string, ClipPreviewTest | undefined>)[host];
  return { box: test?.overlayBox() ?? null, bounds: test?.proxyBounds(actorId) ?? null };
}, { host, actorId }).then(({ box, bounds }) => ({ box: rounded(box), bounds: rounded(bounds) }));
const expectAt = (page: Page, actorId: string, position: number[]) =>
  expect.poll(() => positionOf(page, actorId), { timeout: 10_000 }).toEqual(position);

async function chooseRepresentation(page: Page, label: string) {
  await page.getByTestId("timeline-clip-inspector-preview").getByRole("combobox", { name: "Representation" }).click();
  await page.getByRole("option", { name: label }).click();
}

async function clipProjectFiles() {
  const files = await minimalProjectFiles();
  files.set("assets/Story.timeline.hasset", await encodeAssetDocument({ guid: "story-guid", type: "Timeline", name: "Story", version: 1, payload: { description: "" } }));
  const key = (id: string, Time: number, Value: unknown) => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });
  const payload = {
    ...createDefaultTimelineClipAsset("story-guid"),
    length: 2,
    proxies: [
      // Door rises 2 m over the clip, Relative to its preview placement at (3, 0, 0).
      { id: "door", name: "Door", represents: "actor", classId: "Actor", tracks: [
        { id: "loc", target: { kind: "transform", property: "location" }, valueType: "vec3", keys: [key("a", 0, { x: 0, y: 0, z: 0 }), key("b", 2, { x: 0, y: 2, z: 0 })] },
      ] },
      // Lamp has no tracks.
      { id: "lamp", name: "Lamp", represents: "actor", classId: "Actor", tracks: [] },
    ],
    editorPreview: { proxies: {
      door: { color: "#f97316", representation: "outline", location: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], previewAs: "relative" },
      lamp: { color: "#22d3ee", representation: "outline", location: [-3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], previewAs: "relative" },
    } },
  };
  files.set("assets/Swing.timelineclip3d.hasset", await encodeAssetDocument(
    { guid: "swing-guid", type: "TimelineClip3D", name: "Swing", version: 1, payload: payload as unknown as Record<string, unknown> },
    { headerMeta: timelineClipAssetSummaries(payload as never, "") },
  ));
  return files;
}

async function clip2DProjectFiles() {
  const files = await minimalProjectFiles();
  files.set("assets/Story.timeline.hasset", await encodeAssetDocument({ guid: "story-guid", type: "Timeline", name: "Story", version: 1, payload: { description: "" } }));
  // A 64 x 32 pixel Texture: 0.64 x 0.32 units.
  const texture = { width: 64, height: 32, usage: "color", colorSpace: "srgb" };
  const rgba = new Uint8Array(64 * 32 * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set([220, 64, 90, 255], index);
  files.set("assets/Sprite.hasset", await encodeAssetDocument({ guid: "sprite-tex", name: "Sprite", type: "Texture", version: 1, payload: texture }, {
    headerPayload: texture, extraChunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: await encodeRgbaPng(64, 32, rgba) }],
  }));
  const payload = {
    ...createDefaultTimelineClipAsset("story-guid"),
    length: 2,
    proxies: [{ id: "badge", name: "Badge", represents: "actor", classId: "Actor", tracks: [] }],
    editorPreview: { proxies: { badge: { color: "#f97316", representation: "outline", location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], previewAs: "relative" } } },
  };
  files.set("assets/Pulse.timelineclip2d.hasset", await encodeAssetDocument(
    { guid: "pulse-guid", type: "TimelineClip2D", name: "Pulse", version: 1, payload: payload as unknown as Record<string, unknown> },
    { headerMeta: timelineClipAssetSummaries(payload as never, "") },
  ));
  return files;
}

test.describe("Timeline Clip asset proxies", () => {
  test("follow the clip in every representation, and stay where the gizmo drops them", async ({ page }) => {
    test.setTimeout(180_000);
    await openMinimalTestProject(page, await clipProjectFiles());
    await waitForEditorInteractive(page);
    await openAssetFromBrowser(page, "assets/Swing.timelineclip3d.hasset");
    await expect(page.getByTestId("timeline-clip-preview-canvas")).toBeVisible();
    await expectAt(page, "door", [3, 0, 0]);
    await setPlayhead(page, 1);
    await expectAt(page, "door", [3, 1, 0]);

    // Another representation draws the proxy where the clip puts it.
    await page.getByTestId("timeline-proxies-list").getByText("Door").click();
    for (const label of ["Class", "Model", "Outline"]) {
      await chooseRepresentation(page, label);
      await expectAt(page, "door", [3, 1, 0]);
      await setPlayhead(page, 1.5);
      await expectAt(page, "door", [3, 1.5, 0]);
      await setPlayhead(page, 1);
      await expectAt(page, "door", [3, 1, 0]);
    }

    // A proxy without tracks: the drop moves its preview placement, kept across the playhead and a representation change.
    expect(await nudge(page, "lamp", [0, 0, 2])).toBe(true);
    await expectAt(page, "lamp", [-3, 0, 2]);
    await setPlayhead(page, 0);
    await expectAt(page, "lamp", [-3, 0, 2]);
    await page.getByTestId("timeline-proxies-list").getByText("Lamp").click();
    await chooseRepresentation(page, "Class");
    await expectAt(page, "lamp", [-3, 0, 2]);

    // With Auto Key, a drop on the tracked Location keys it at the playhead; the rest of the clip is unchanged.
    await page.getByTestId("timeline-auto-key").click();
    await setPlayhead(page, 1);
    await expectAt(page, "door", [3, 1, 0]);
    expect(await nudge(page, "door", [1, 0, 0])).toBe(true);
    await expectAt(page, "door", [4, 1, 0]);
    await setPlayhead(page, 0);
    await expectAt(page, "door", [3, 0, 0]);
    await setPlayhead(page, 1);
    await expectAt(page, "door", [4, 1, 0]);

  });

  test("keep their place, size and picked Texture across representations, and the 2D box frames a loaded Texture", async ({ page }) => {
    test.setTimeout(180_000);
    await openMinimalTestProject(page, await clip2DProjectFiles());
    await waitForEditorInteractive(page);
    await openAssetFromBrowser(page, "assets/Pulse.timelineclip2d.hasset");
    await expect(page.getByTestId("timeline-clip-preview-canvas")).toBeVisible();
    await expectAt(page, "badge", [0, 0, 0]);
    await page.getByTestId("timeline-proxies-list").getByText("Badge").click();

    // Moved and doubled without tracks: the preview placement holds both.
    expect(await nudge(page, "badge", [2, 1, 0], 2)).toBe(true);
    const doubled = { box: { center: [2, 1], size: [2, 2] }, bounds: { center: [2, 1], size: [2, 2] } };
    await expect.poll(() => framing(page, "badge"), { timeout: 10_000 }).toEqual(doubled);
    await expect(page.getByTestId("timeline-clip-inspector-preview").getByLabel("Scale X")).toHaveValue("2");

    // The Texture draws at its size times the placement's Scale; the box follows it as it loads.
    await chooseRepresentation(page, "Texture");
    await page.getByTestId("timeline-clip-inspector-preview").getByTestId("property-timeline-proxy-asset").click();
    await page.getByTestId("asset-picker").getByTestId("search-item-sprite-tex").click();
    const textured = { box: { center: [2, 1], size: [1.28, 0.64] }, bounds: { center: [2, 1], size: [1.28, 0.64] } };
    await expect.poll(() => framing(page, "badge"), { timeout: 20_000 }).toEqual(textured);

    await chooseRepresentation(page, "Outline");
    await expect.poll(() => framing(page, "badge"), { timeout: 10_000 }).toEqual(doubled);
    // Back to Texture: the one picked before draws again.
    await chooseRepresentation(page, "Texture");
    await expect(page.getByTestId("timeline-clip-inspector-preview").getByTestId("property-timeline-proxy-asset")).toContainText("Sprite");
    await expect.poll(() => framing(page, "badge"), { timeout: 20_000 }).toEqual(textured);
  });
});
