import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

/** Reproducibility metadata; desktop functional captures never certify A16. */
export function renderingEvidence(sceneSource: string, graphicsArguments =
  process.env.BL_RENDER_NATIVE_GPU === "1" && !process.env.CI
    ? test.info().project.use.launchOptions?.args ?? [] : SOFTWARE_WEBGPU_ARGS) {
  return {
    kind: "desktop-functional-only",
    recordedAt: new Date().toISOString(),
    buildRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    artifactSha256: process.env.BL_TEST_BUILD_KEY,
    sceneSource,
    sceneSourceSha256: createHash("sha256").update(readFileSync(sceneSource)).digest("hex"),
    host: { os: platform(), osVersion: release(), arch: arch(), cpu: cpus()[0]?.model },
    graphicsArguments,
    a16Acceptance: "deferred-by-user-unmeasured",
  };
}
