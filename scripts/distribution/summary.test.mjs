import assert from "node:assert/strict";
import test from "node:test";
import { platformSummary } from "./summary.mjs";

test("partial success retains platform identity without claiming complete distribution", () => {
  const report = platformSummary({ validate: { result: "success", outputs: { dry_run: "false", windows: "true", ipados: "true" } }, windows: { result: "success" }, ipados: { result: "success", outputs: { uploaded: "true" } }, testflight: { result: "failure", outputs: { state: "processing" } }, "publish-windows": { result: "failure" } });
  assert.match(report.text, /partial|incomplete/i);
  assert.match(report.text, /processing/);
  assert.match(report.text, /not published/i);
  assert.equal(report.complete, false);
});

test("dry run and rejected refs never claim a distribution completed", () => {
  const dry = platformSummary({ validate: { result: "success", outputs: { dry_run: "true" } } });
  assert.match(dry.text, /Dry run/);
  assert.equal(dry.complete, false);
  const invalid = platformSummary({ validate: { result: "skipped" } });
  assert.match(invalid.text, /rejected|not validated/i);
  assert.equal(invalid.failed, true);
});
