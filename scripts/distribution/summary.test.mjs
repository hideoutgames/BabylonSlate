import assert from "node:assert/strict";
import test from "node:test";
import { platformSummary } from "./summary.mjs";

const outputs = { dry_run: "false", windows: "true", macos: "true", linux: "false", android: "true", ipados: "true" };

test("partial success reports each package independently without claiming completion", () => {
  const report = platformSummary({
    validate: { result: "success", outputs },
    windows: { result: "success" }, macos: { result: "failure" }, android: { result: "success" },
    ipados: { result: "success", outputs: { uploaded: "true" } },
    testflight: { result: "failure", outputs: { state: "processing" } },
    "publish-release": { result: "failure" },
  });
  assert.match(report.text, /partial|incomplete/i);
  assert.match(report.text, /processing/);
  assert.match(report.text, /Packaged and checked; not published/);
  assert.match(report.text, /Packaging incomplete or cancelled/);
  assert.match(report.text, /Linux \| Not requested/);
  assert.equal(report.complete, false);
});

test("all requested release platforms and available Apple build complete the operation", () => {
  const report = platformSummary({
    validate: { result: "success", outputs },
    "publish-release": { result: "success" },
    testflight: { result: "success", outputs: { state: "available" } },
  });
  assert.equal(report.complete, true);
  assert.match(report.text, /Published \(see release\)/);
});

test("dry run and rejected refs never claim a distribution completed", () => {
  const dry = platformSummary({ validate: { result: "success", outputs: { dry_run: "true" } } });
  assert.match(dry.text, /Dry run/);
  assert.equal(dry.complete, false);
  const invalid = platformSummary({ validate: { result: "skipped" } });
  assert.match(invalid.text, /rejected|not validated/i);
  assert.equal(invalid.failed, true);
});
