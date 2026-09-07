import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactIdentity, verifyArtifactIdentity } from "./test-build.mjs";

test("build identity changes with source, toolchain and build configuration", () => {
  const source = { commit: "a", digest: "one", clean: true };
  const first = artifactIdentity(source, {
    node: "22",
    platform: "linux",
    base: "/",
  });
  assert.notEqual(
    first.key,
    artifactIdentity(
      { ...source, digest: "two" },
      { node: "22", platform: "linux", base: "/" },
    ).key,
  );
  assert.notEqual(
    first.key,
    artifactIdentity(source, { node: "24", platform: "linux", base: "/" }).key,
  );
  assert.notEqual(
    first.key,
    artifactIdentity(source, {
      node: "22",
      platform: "linux",
      base: "/BabylonSlate/",
    }).key,
  );
  assert.equal(verifyArtifactIdentity(first, first), true);
  assert.equal(
    verifyArtifactIdentity(first, { ...first, key: "stale" }),
    false,
  );
});
