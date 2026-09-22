import { expect, test } from "@playwright/test";
import type { runSharedOutlineProof } from "../apps/editor/src/testing/shared-outline-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { renderingEvidence } from "./rendering-evidence";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`shared production outlines preserve consumers, occlusion and bounded work on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?test=1&sharedOutlineProof=1");
    await page.waitForFunction(() => "__babylonslateSharedOutlineProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as {
      __babylonslateSharedOutlineProof: typeof runSharedOutlineProof;
    }).__babylonslateSharedOutlineProof(backend), backend);
    for (const snapshot of report.snapshots)
      await testInfo.attach(snapshot.name, { body: Buffer.from(snapshot.image.split(",")[1]!, "base64"), contentType: "image/png" });
    await testInfo.attach("shared-outline-qualification", {
      body: JSON.stringify({ ...report, evidence: renderingEvidence("apps/editor/src/testing/shared-outline-proof.ts"),
        snapshots: report.snapshots.map(({ image: _image, ...snapshot }) => snapshot), errors }),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(report.effectiveBackend).toBe(backend);
    const at = (name: string) => {
      const snapshot = report.snapshots.find((entry) => entry.name === name);
      expect(snapshot, name).toBeDefined();
      return snapshot!;
    };
    const original = at("three-disjoint-instances");
    expect(original.lanes[0]!.red).toBeGreaterThan(0);
    expect(original.lanes[1]!.blue).toBeGreaterThan(0);
    expect(original.lanes[2]!.green).toBeGreaterThan(0);
    for (const name of ["identical-requests", "all-visibility-groups", "live-component-style-restored", "consumer-order-reversed", "sibling-view-selection-isolated", "sibling-view-disposed"])
      expect(at(name).lanes, name).toEqual(original.lanes);
    for (const [key, lane, color] of [["global", 0, "red"], ["component", 1, "blue"], ["selection", 2, "green"]] as const) {
      for (const action of ["remove", "dispose"]) {
        const snapshot = at(`${action}-${key}`);
        expect(snapshot.lanes[lane]![color], `${action} ${key}`).toBe(0);
        for (const survivor of [0, 1, 2].filter((index) => index !== lane))
          expect(snapshot.lanes[survivor], `${action} ${key}: survivor ${survivor}`).toEqual(original.lanes[survivor]);
      }
      expect(at(`restore-${key}`).lanes).toEqual(original.lanes);
    }
    const unchanged = at("identical-requests");
    expect(unchanged.graphs).toEqual(original.graphs);
    expect(unchanged.textures).toEqual(original.textures);
    expect(unchanged.owner).toEqual(original.owner);
    expect(unchanged.view).toEqual(original.view);
    const edited = at("live-component-color-and-width");
    expect(edited.lanes[1]!.blue).toBe(0);
    expect(edited.lanes[1]!.red).toBeGreaterThan(original.lanes[1]!.blue);
    expect(edited.lanes[0]).toEqual(original.lanes[0]);
    expect(edited.lanes[2]).toEqual(original.lanes[2]);
    expect(edited.graphs).toEqual(original.graphs);
    expect(edited.textures).toEqual(original.textures);
    expect(edited.owner).toEqual(original.owner);
    const beforeResize = at("all-visibility-groups");
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(at(`resize-${cycle}-larger`).drawingBuffer).toEqual({ width: 320, height: 160 });
      const restored = at(`resize-${cycle}-restored`);
      expect(restored.drawingBuffer).toEqual({ width: 240, height: 120 });
      expect(restored.lanes).toEqual(beforeResize.lanes);
      expect(restored.reservations).toEqual(beforeResize.reservations);
      expect(restored.owner.instanceBufferBytes).toBe(beforeResize.owner.instanceBufferBytes);
    }
    expect(at("membership-order-reversed").lanes).toEqual(at("overlap-with-global").lanes);
    expect(at("same-instance-selection-wins").lanes[1]!.green).toBeGreaterThan(0);
    expect(at("same-instance-selection-wins").lanes[1]!.blue).toBe(0);
    expect(at("same-instance-component-survives").lanes[1]!.blue).toBeGreaterThan(0);
    expect(at("same-instance-component-survives").lanes[1]!.green).toBe(0);
    expect(at("same-instance-global-revealed").lanes[1]!.red).toBeGreaterThan(0);
    expect(at("same-instance-global-revealed").lanes[1]!.blue).toBe(0);

    const strict = at("strict-full-and-partial-occlusion");
    expect(strict.lanes[0]!.red).toBe(0);
    expect(strict.lanes[2]!.red).toBe(0);
    expect(strict.lanes[1]!.red).toBeGreaterThan(0);
    expect(strict.coveredPartialRed).toBe(0);
    const through = at("through-component-keeps-global-strict");
    expect(through.lanes[2]!.blue).toBeGreaterThan(0);
    expect(through.lanes[0]!.red).toBe(0);
    expect(through.lanes[1]).toEqual(strict.lanes[1]);
    expect(through.coveredPartialRed).toBe(0);
    expect(at("through-component-removed").lanes).toEqual(strict.lanes);
    expect(at("occluders-removed").lanes).toEqual(at("same-instance-global-revealed").lanes);
    expect(report.highIdentities).toEqual([2048, 2049, 65_535]);
    expect(at("high-identity-colors").lanes).toEqual(original.lanes);
    expect(at("high-identity-component-removed").lanes[0]).toEqual(original.lanes[0]);
    expect(at("high-identity-component-removed").lanes[1]!.red).toBeGreaterThan(0);
    expect(at("high-identity-component-removed").lanes[1]!.blue).toBe(0);
    expect(at("high-identity-component-removed").lanes[2]).toEqual(original.lanes[2]);

    const baseline = at("disabled-baseline"), retired = at("all-disabled-retired"), steady = at("all-disabled-steady");
    expect(retired.lanes).toEqual(baseline.lanes);
    expect(retired.tasks).toEqual(baseline.tasks);
    expect(retired.draws).toBe(baseline.draws);
    expect(retired.reservations).toEqual(baseline.reservations);
    expect(retired.owner.instanceBufferBytes).toBe(0);
    expect(retired.owner.sourceCount).toBe(0);
    expect(retired.outline).toEqual({ drawingPassCount: 0, renderRecordCount: 0 });
    expect(steady.tasks).toEqual(retired.tasks);
    expect(steady.graphs).toEqual(retired.graphs);
    expect(steady.textures).toEqual(retired.textures);
    expect(steady.reservations).toEqual(retired.reservations);
    const styles = at("forty-eight-independent-styles"), fewerStyles = at("style-count-baseline");
    expect(styles.objectRenderers).toBe(fewerStyles.objectRenderers);
    expect(styles.outline).toEqual(fewerStyles.outline);
    expect(at("all-visibility-groups").outline).toEqual({ drawingPassCount: 4, renderRecordCount: 7 });
    for (const snapshot of report.snapshots) {
      expect(snapshot.outline.drawingPassCount, snapshot.name).toBeLessThanOrEqual(4);
      expect(snapshot.outline.renderRecordCount, snapshot.name).toBeLessThanOrEqual(7);
    }
  });
}
