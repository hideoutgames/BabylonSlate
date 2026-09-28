import { createHash } from "node:crypto";
import { GITHUB_RELEASE_PLATFORMS, artifactNames, platformArtifactNames, releaseAssetNames, releaseDisposition, requestedPlatforms, validateArtifacts } from "./contract.mjs";
import { resolveTag } from "./preflight.mjs";
import { patchNotesMarkdown, validatePatchNotes } from "./changelog.mjs";
import { validateUpdateFeed } from "./update-feed.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;

export function identityNotes(identity) {
  return `BabylonSlate ${identity.applicationVersion}\nChannel: ${identity.channel === "test" ? "Test (Indev)" : "Release"}\nPackage version: ${identity.packageVersion}\nApple version/build: ${identity.appleMarketingVersion} / ${identity.appleBuildNumber}\nAndroid versionCode: ${identity.androidVersionCode}\nSource: ${identity.sourceSha}\nWorkflow run/attempt: ${identity.runNumber} / ${identity.runAttempt}`;
}

function verifyChecksums(platform, files) {
  const checksums = files.get("SHA256SUMS.txt")?.toString("utf8");
  const expected = [...files]
    .filter(([name]) => name !== "SHA256SUMS.txt")
    .map(([name, bytes]) => `${digest(bytes)}  ${name}`)
    .sort();
  if (!checksums || JSON.stringify(checksums.trim().split("\n").sort()) !== JSON.stringify(expected)) throw new Error(`${platform} checksum validation failed`);
}

export async function publishRelease({ identity, platformFiles, appleState }, api) {
  const selected = requestedPlatforms(identity.platforms);
  const requested = selected.filter(platform => GITHUB_RELEASE_PLATFORMS.includes(platform)).sort();
  if (platformFiles.size !== requested.length || requested.some(platform => !platformFiles.has(platform)) || [...platformFiles.keys()].some(platform => !requested.includes(platform))) {
    throw new Error("Every requested platform package is required before publication");
  }
  if (identity.channel === "release" && selected.includes("ipados") && !["available", "awaiting-beta-review"].includes(appleState)) {
    throw new Error("Apple has not reached a state permitting a normal release; preserve the platform artifacts and retry finalization/publication");
  }
  if (identity.channel === "release") validatePatchNotes(identity.patchNotes, identity.applicationVersion);

  const assets = new Map();
  const toolchains = {};
  let macosSigned;
  for (const platform of requested) {
    const files = platformFiles.get(platform);
    validateArtifacts(platformArtifactNames(platform, identity.packageVersion), [...files.keys()]);
    verifyChecksums(platform, files);
    const manifest = JSON.parse(files.get("build-manifest.json").toString("utf8"));
    if (manifest.platform !== platform) throw new Error(`${platform} manifest identity differs from the validated build`);
    const { toolchains: platformToolchains = {}, platform: _platform, macosSigned: signed, ...manifestIdentity } = manifest;
    if (JSON.stringify(stable(manifestIdentity)) !== JSON.stringify(stable(identity))) throw new Error(`${platform} manifest identity differs from the validated build`);
    for (const [key, value] of Object.entries(platformToolchains)) {
      if (toolchains[key] !== undefined && toolchains[key] !== value) throw new Error(`Conflicting toolchain version: ${key}`);
      toolchains[key] = value;
    }
    if (platform === "macos") macosSigned = signed;
    if (identity.channel === "release" && ["windows", "macos", "linux"].includes(platform)) validateUpdateFeed(platform, identity.packageVersion, files);
    for (const name of artifactNames(platform, identity.packageVersion)) {
      if (assets.has(name)) throw new Error("Artifacts must exactly match the public allowlist");
      assets.set(name, files.get(name));
    }
  }

  const mergedManifest = {
    ...identity,
    toolchains,
    platformsBuilt: requested,
    ...(requested.includes("macos") ? { macosSigned: macosSigned === true } : {}),
  };
  assets.set("build-manifest.json", Buffer.from(JSON.stringify(mergedManifest, null, 2) + "\n"));
  assets.set("SHA256SUMS.txt", Buffer.from([...assets]
    .map(([name, bytes]) => `${digest(bytes)}  ${name}\n`)
    .sort()
    .join("")));
  validateArtifacts(releaseAssetNames(requested, identity.packageVersion), [...assets.keys()]);

  const tagSha = await resolveTag(api, identity.tag);
  let release = await api(`/releases/tags/${encodeURIComponent(identity.tag)}`, { optional: true });
  releaseDisposition(identity, tagSha, release);
  const notes = identity.patchNotes ? `${patchNotesMarkdown(identity.patchNotes)}\n\n` : "";
  const descriptions = {
    windows: "Unsigned x64 NSIS installer; Windows may warn about an unrecognized publisher",
    macos: `arm64 and x64 DMG/ZIP; ${macosSigned === true ? "signed and notarized" : "unsigned: open via Privacy & Security → Open Anyway; automatic updates are disabled for unsigned macOS packages"}`,
    linux: "x64 AppImage; mark executable",
    android: "universal APK signed with the BabylonSlate release key; sideload requires allowing installs from this source",
  };
  const platformLines = GITHUB_RELEASE_PLATFORMS.map(platform => `${platform === "macos" ? "macOS" : platform[0].toUpperCase() + platform.slice(1)}: ${requested.includes(platform) ? descriptions[platform] : "Not requested"}.`);
  platformLines.push(`iPadOS: ${selected.includes("ipados") ? appleState ?? "unknown" : "Not requested"}. Upload is distinct from tester availability. No App Store submission.`);
  const updateNote = identity.channel === "release" ? "Automatic updates are enabled by default on supported packages; disable them in Engine Settings." : "Test builds do not automatically update.";
  const body = `${notes}${identityNotes(identity)}\n\n${platformLines.join("\n")}\n\n${updateNote}\n`;
  if (!release) release = await api("/releases", { method: "POST", body: { tag_name: identity.tag, target_commitish: identity.sourceSha, name: identity.title, body, draft: true, prerelease: identity.prerelease, make_latest: "false" } });
  if (release.assets.some(asset => !assets.has(asset.name))) throw new Error("Draft contains unexpected assets; inspect it before recovery");
  for (const [name, bytes] of assets) {
    const existing = release.assets.find(asset => asset.name === name);
    if (existing) {
      if (existing.size !== bytes.length || existing.digest !== `sha256:${digest(bytes)}` || existing.state !== "uploaded") throw new Error("Draft asset differs; existing assets will not be replaced");
      continue;
    }
    const uploadUrl = new URL(release.upload_url.split("{")[0]);
    if (uploadUrl.origin !== "https://uploads.github.com") throw new Error("Unexpected release upload host");
    uploadUrl.searchParams.set("name", name);
    await api(uploadUrl.href, { method: "POST", bytes, contentType: /\.(?:exe|blockmap|dmg|zip|AppImage|apk)$/.test(name) ? "application/octet-stream" : "text/plain" });
  }
  release = await api(`/releases/${release.id}`);
  validateArtifacts(releaseAssetNames(requested, identity.packageVersion), release.assets.map(asset => asset.name));
  for (const asset of release.assets) {
    const bytes = assets.get(asset.name);
    if (asset.size !== bytes.length || asset.digest !== `sha256:${digest(bytes)}` || asset.state !== "uploaded") throw new Error("Uploaded asset verification failed; draft preserved");
  }
  releaseDisposition(identity, await resolveTag(api, identity.tag), release);
  return api(`/releases/${release.id}`, { method: "PATCH", body: { name: identity.title, body, draft: false, prerelease: identity.prerelease, make_latest: identity.makeLatest } });
}
