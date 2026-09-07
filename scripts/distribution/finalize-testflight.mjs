import { appendFile } from "node:fs/promises";
import { appleClient } from "./apple-api.mjs";
import { validateAppleConfiguration } from "./apple-contract.mjs";
import { allApplePages, finalizeTestFlight, validatePrivateGroups } from "./testflight.mjs";

let state = "failed";
try {
  const identity = JSON.parse(process.env.APPLE_IDENTITY);
  validateAppleConfiguration(process.env, identity, false);
  const api = appleClient();
  const groups = await allApplePages(api, `/v1/betaGroups?filter[app]=${process.env.ASC_APP_ID}&limit=200`);
  const ids = { test: process.env.APPLE_TEST_GROUP_ID, release: process.env.APPLE_RELEASE_GROUP_ID };
  validatePrivateGroups(groups, ids);
  const result = await finalizeTestFlight({ identity, appId: process.env.ASC_APP_ID, group: groups.find(group => group.id === ids[identity.channel]) }, { api });
  state = result.state;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\niPadOS ${identity.appleMarketingVersion} / ${identity.appleBuildNumber}: **${state}**. Source: \`${identity.sourceSha}\`. Retry finalization with this exact identity; do not re-upload to resolve processing delays.\n`);
} catch {
  console.error("TestFlight finalization failed; check API permissions, private group settings, and the exact version/build in App Store Connect. No private diagnostics were published.");
} finally {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `state=${state}\n`);
  if (!["available", "awaiting-beta-review"].includes(state)) process.exitCode = 1;
}
