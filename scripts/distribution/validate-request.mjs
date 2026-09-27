import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { GITHUB_RELEASE_PLATFORMS, requestedPlatforms } from "./contract.mjs";
import { preflight } from "./preflight.mjs";
import { githubClient } from "./github.mjs";

try {
  if (process.env.INPUT_OPERATION === "finalize-testflight" && !process.env.INPUT_SOURCE_SHA) throw new Error("Finalization requires the original explicit source SHA");
  const result = await preflight({
    sourceSha: process.env.INPUT_SOURCE_SHA || process.env.GITHUB_SHA,
    version: process.env.INPUT_VERSION,
    channel: process.env.INPUT_CHANNEL,
    platforms: process.env.INPUT_PLATFORMS,
    dryRun: process.env.INPUT_DRY_RUN === "true",
    runNumber: Number(process.env.GITHUB_RUN_NUMBER),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    workflowRef: process.env.GITHUB_REF,
    eventName: process.env.GITHUB_EVENT_NAME,
    operation: process.env.INPUT_OPERATION,
    existingBuildNumber: process.env.INPUT_EXISTING_BUILD_NUMBER,
  }, {
    api: githubClient(),
    git: async args => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
  });
  const { identity } = result;
  const requested = requestedPlatforms(identity.platforms);
  const enabled = platform => requested.includes(platform);
  const githubRelease = GITHUB_RELEASE_PLATFORMS.some(enabled);
  const outputs = ["windows", "macos", "linux", "android", "ipados"].map(platform => `${platform}=${enabled(platform)}`).join("\n");
  await appendFile(process.env.GITHUB_OUTPUT, `source_sha=${identity.sourceSha}\nidentity=${JSON.stringify(identity)}\ndry_run=${result.dryRun}\n${outputs}\ngithub_release=${githubRelease}\n`);
  const lines = ["windows", "macos", "linux", "android"].map(platform => `\n${platform === "macos" ? "macOS" : platform[0].toUpperCase() + platform.slice(1)}: ${enabled(platform) ? `\`${identity.tag}\`` : "Not requested"}`);
  lines.push(`\niPadOS: ${enabled("ipados") ? `${identity.appleMarketingVersion} / ${identity.appleBuildNumber}, private ${identity.testFlightGroup}` : "Not requested"}`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${result.dryRun ? "Dry Run" : "Validated Request"}\n\n${identity.title}\n\nSource: \`${identity.sourceSha}\`\n${lines.join("\n")}\n\nExact-source Verify run: ${result.verifyRunId}. No App Store submission.\n`);
} catch (error) {
  console.error(error instanceof Error && !error.message.includes("Command failed") ? error.message : "Source validation failed; confirm the commit exists on protected main");
  process.exitCode = 1;
}
