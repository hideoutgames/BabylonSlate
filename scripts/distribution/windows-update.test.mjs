import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { validateWindowsUpdate } from "./windows-update.mjs";

test("feed metadata must identify and hash the actual installer", () => {
  const version = "1.2.3-release";
  const name = "BabylonSlate-1.2.3-release-x64.exe";
  const bytes = Buffer.from("installer bytes");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const metadata = { version, files: [{ url: name, sha512, size: 15 }], path: name, sha512 };
  const files = value => new Map([[name, bytes], ["latest.yml", Buffer.from(JSON.stringify(value))]]);
  assert.doesNotThrow(() => validateWindowsUpdate(version, files(metadata)));
  for (const patch of [
    { version: "1.2.4-release" }, { files: [{ url: "other.exe", sha512, size: 15 }] },
    { files: [{ url: name, sha512: "wrong", size: 15 }] }, { files: [{ url: name, sha512, size: 14 }] },
    { path: "other.exe" }, { sha512: "wrong" },
  ]) assert.throws(() => validateWindowsUpdate(version, files({ ...metadata, ...patch })), /metadata/);
});
