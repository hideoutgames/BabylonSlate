import assert from "node:assert/strict";
import test from "node:test";
import { appleUploadErrors } from "./apple-upload-errors.mjs";

test("upload failures publish Apple's reason without identifiers, paths or tokens", () => {
  const output = [
    "[22:45:01]: Uploading ipa to App Store Connect",
    "\u001b[31m[22:45:09]: [Transporter Error Output]: ERROR ITMS-90683: \"Missing purpose string in Info.plist\" for team ABCDE12345 at /Users/runner/work/private/App.ipa\u001b[0m",
    "[22:45:09]: Authentication failed for dev@example.com with key 11111111-2222-3333-4444-555555555555",
    `[22:45:09]: error: token ${"Q".repeat(40)} rejected for app 6800000000`,
    "[22:45:09]: Successfully loaded the build settings"
  ].join("\n");
  assert.deepEqual(appleUploadErrors(output, ["ABCDE12345", "6800000000"]), [
    "[Transporter Error Output]: ERROR ITMS-90683: \"Missing purpose string in Info.plist\" for team [redacted] at [path]",
    "Authentication failed for [email] with key [id]",
    "error: token [token] rejected for app [redacted]"
  ]);
});

test("upload failure output is capped in lines and length", () => {
  const output = Array.from({ length: 20 }, (_, index) => `ERROR ITMS-9000${index % 10}: ${"x ".repeat(200)}${index}`).join("\n");
  const reasons = appleUploadErrors(output);
  assert.equal(reasons.length, 6);
  assert.ok(reasons.every(reason => reason.length <= 200));
});
