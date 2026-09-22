import { expect, test } from "@playwright/test";
import type { runSharedOutlineGeometryProof } from "../apps/editor/src/testing/shared-outline-geometry-proof";
import type { SharedOutlineProofProgress } from "../apps/editor/src/testing/shared-outline-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { renderingEvidence } from "./rendering-evidence";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`shared outlines follow material coverage, thin groups, LOD and deformation on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const evidence = renderingEvidence("apps/editor/src/testing/shared-outline-geometry-proof.ts");
    await testInfo.attach("shared-outline-geometry-run", { body: JSON.stringify({ requestedBackend: backend, evidence }), contentType: "application/json" });
    const diagnostics: Array<{ kind: string; text: string; location?: { url: string; lineNumber: number; columnNumber: number } }> = [];
    const pendingDiagnostics: Promise<void>[] = [];
    const progress: Omit<SharedOutlineProofProgress, "image">[] = [];
    const recordDiagnostic = (entry: typeof diagnostics[number]) => {
      diagnostics.push(entry);
      pendingDiagnostics.push(testInfo.attach(`browser-diagnostic-${diagnostics.length}`, { body: JSON.stringify(entry), contentType: "application/json" }));
    };
    page.on("pageerror", (error) => recordDiagnostic({ kind: "page-error", text: error.message }));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        recordDiagnostic({ kind: `console-${message.type()}`, text: message.text(), location: message.location() });
    });
    await page.exposeFunction("__babylonslateSharedOutlineGeometryProgress", async (entry: SharedOutlineProofProgress) => {
      const { image, ...record } = entry;
      progress.push(record);
      if (image) await testInfo.attach(entry.stage, { body: Buffer.from(image.split(",")[1]!, "base64"), contentType: "image/png" });
      await testInfo.attach(`progress-${progress.length}-${entry.stage}`, { body: JSON.stringify(record), contentType: "application/json" });
    });
    await page.goto("/?test=1&sharedOutlineGeometryProof=1");
    await page.waitForFunction(() => "__babylonslateSharedOutlineGeometryProof" in window);
    const report = await page.evaluate((backend) => {
      const host = window as unknown as {
        __babylonslateSharedOutlineGeometryProof: typeof runSharedOutlineGeometryProof;
        __babylonslateSharedOutlineGeometryProgress: (entry: SharedOutlineProofProgress) => Promise<void>;
      };
      return host.__babylonslateSharedOutlineGeometryProof(backend, (entry) => host.__babylonslateSharedOutlineGeometryProgress(entry));
    }, backend).finally(async () => {
      await Promise.all(pendingDiagnostics);
      await testInfo.attach("shared-outline-geometry-progress", { body: JSON.stringify({ evidence, progress, diagnostics }), contentType: "application/json" });
    });
    await testInfo.attach("shared-outline-geometry-qualification", { body: JSON.stringify({ ...report, evidence, diagnostics }), contentType: "application/json" });
    expect(report.effectiveBackend).toBe(backend);
    expect(diagnostics.filter((entry) => entry.kind === "page-error" || entry.kind === "console-error" ||
      /GPUValidationError|validation error|WebGL.*INVALID_|shader.*(?:error|failed)/i.test(entry.text))).toEqual([]);
    const at = (name: string) => {
      const result = report.cases.find((entry) => entry.name === name);
      expect(result, name).toBeDefined(); return result!;
    };
    // All silhouettes use the ordinary material pass as ground truth. Missing
    // geometry, phantom cutout rectangles and stale deformation each fail here.
    for (const result of report.cases) {
      expect(result.native.outline, result.name).toEqual({ drawingPassCount: 0, renderRecordCount: 0 });
      expect(result.detachedOutlinePixels, result.name).toBe(0);
      if (result.boundaryPixels) {
        expect(result.coveredBoundaryPixels / result.boundaryPixels, result.name).toBeGreaterThanOrEqual(0.95);
        expect(result.rendered.red + result.rendered.blue, result.name).toBeGreaterThan(0);
      } else expect(result.rendered.red + result.rendered.blue, result.name).toBe(0);
      expect(result.rendered.outline.drawingPassCount, result.name).toBeLessThanOrEqual(4);
      expect(result.rendered.outline.renderRecordCount, result.name).toBeLessThanOrEqual(7);
    }
    const submeshes = at("multi-material-cutout");
    expect(submeshes.native.count).toBeGreaterThan(1_500);
    expect(at("live-alpha-cutoff").native.count).toBeLessThan(submeshes.native.count);
    expect(at("live-uv-transform").native.centroid![0]).not.toBe(at("live-alpha-cutoff").native.centroid![0]);
    expect(at("uv2-only-index-zero").native.count).toBeLessThan(at("uv2-only-index-one").native.count);
    expect(at("live-material-clip-plane").native.count).toBeLessThan(at("clip-unrestricted").native.count * 0.6);
    expect(at("negative-nonuniform-scale").native.count).toBeGreaterThan(0);
    const thin = at("two-thin-actor-groups");
    expect(thin.rendered.red).toBeGreaterThan(0); expect(thin.rendered.blue).toBeGreaterThan(0);
    for (const name of ["thin-first-consumer-removed", "thin-first-actor-disposed"]) {
      const capture = report.captures.find((entry) => entry.name === name)!;
      expect(capture.red, name).toBe(0);
      expect(capture.blue, name).toBe(thin.rendered.blue);
    }
    expect(at("late-lod-selected").native.count).toBeLessThan(at("before-late-lod").native.count * 0.5);
    expect(at("position-and-color-morph").native.centroid![0]).toBeGreaterThan(at("morph-rest").native.centroid![0]! + 30);
    expect(at("skeleton-pose").native.centroid![0]).toBeLessThan(at("skeleton-rest").native.centroid![0]! - 30);
    expect(at("authored-wpo").native.centroid![0]).toBeGreaterThan(150);
    expect(at("authored-wpo-parameter-edit").native.centroid![0]).toBeLessThan(95);
    expect(at("authored-discard-parameter-edit").native.count).toBe(0);
    expect(at("authored-discard-parameter-edit").rendered.count).toBe(0);
    expect(at("authored-parameters-reset").native).toMatchObject({
      count: at("authored-wpo").native.count, centroid: at("authored-wpo").native.centroid,
    });
    const retired = report.captures.find((entry) => entry.name === "all-geometry-removed")!;
    expect(retired.count).toBe(0);
    expect(retired.outline).toEqual({ drawingPassCount: 0, renderRecordCount: 0 });
    expect(retired.owner.sourceCount).toBe(0);
    expect(retired.owner.instanceBufferBytes).toBe(0);
  });
}
