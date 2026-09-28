import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity, GITHUB_RELEASE_PLATFORMS, requestedPlatforms } from "./contract.mjs";
import { githubClient } from "./github.mjs";
import { publishRelease } from "./publish.mjs";

try {
  const identity = JSON.parse(process.env.RELEASE_IDENTITY ?? "null");
  if (!identity) throw new Error("RELEASE_IDENTITY is required");
  const sequence = Number(String(identity.appleBuildNumber).split(".")[0]);
  const canonical = createIdentity({ ...identity, version: identity.applicationVersion, declaredVersion: identity.applicationVersion, appleSequenceOffset: sequence - identity.runNumber });
  for (const [key, value] of Object.entries(canonical)) if (JSON.stringify(identity[key]) !== JSON.stringify(value)) throw new Error("Release identity is not canonical");
  const directory = process.argv[2];
  if (!directory) throw new Error("Release package directory is required");
  const requested = requestedPlatforms(identity.platforms).filter(platform => GITHUB_RELEASE_PLATFORMS.includes(platform));
  const platformFiles = new Map();
  for (const platform of requested) {
    const platformDirectory = join(directory, platform);
    try {
      const files = new Map();
      for (const name of await readdir(platformDirectory)) files.set(name, await readFile(join(platformDirectory, name)));
      platformFiles.set(platform, files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const release = await publishRelease({ identity, platformFiles, appleState: process.env.APPLE_STATE }, githubClient());
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nPublished ${identity.title}: ${release.html_url}\n\nAll requested package assets, checksums and merged build manifest verified.\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release publication failed; inspect draft state");
  process.exitCode = 1;
}
