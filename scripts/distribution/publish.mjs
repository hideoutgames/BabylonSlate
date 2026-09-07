import { createHash } from "node:crypto";
import { releaseDisposition, validateArtifacts } from "./contract.mjs";
import { resolveTag } from "./preflight.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function identityNotes(manifest) {
  return `BabylonSlate ${manifest.applicationVersion}\nChannel: ${manifest.channel === "test" ? "Test (Indev)" : "Release"}\nWindows version: ${manifest.windowsVersion}\nApple version/build: ${manifest.appleMarketingVersion} / ${manifest.appleBuildNumber}\nSource: ${manifest.sourceSha}\nWorkflow run/attempt: ${manifest.runNumber} / ${manifest.runAttempt}`;
}

export async function publishWindows({ manifest, files, appleState }, api) {
  if (manifest.channel === "release" && manifest.platforms === "both" && !["available", "awaiting-beta-review"].includes(appleState)) throw new Error("Apple has not reached a state permitting a normal Windows release; preserve the Windows artifact and retry finalization/publication");
  validateArtifacts(manifest.windowsVersion, [...files.keys()]);
  const checksums = files.get("SHA256SUMS.txt").toString("utf8");
  const expectedChecksums = [...files].filter(([name]) => name !== "SHA256SUMS.txt").map(([name, bytes]) => `${digest(bytes)}  ${name}`).sort();
  if (JSON.stringify(checksums.trim().split("\n").sort()) !== JSON.stringify(expectedChecksums)) throw new Error("Windows checksum validation failed");
  if (JSON.stringify(JSON.parse(files.get("build-manifest.json"))) !== JSON.stringify(manifest)) throw new Error("Windows manifest identity differs from the validated build");
  const tagSha = await resolveTag(api, manifest.tag);
  let release = await api(`/releases/tags/${encodeURIComponent(manifest.tag)}`, { optional: true });
  releaseDisposition(manifest, tagSha, release);
  const body = `${identityNotes(manifest)}\n\nUnsigned Windows x64 NSIS installer. Windows may display an unrecognized-publisher warning. No automatic updater.\n\niPadOS: ${manifest.platforms === "windows" ? "Not requested" : appleState ?? "unknown"}. Upload is distinct from tester availability. No App Store submission.\n`;
  if (!release) release = await api("/releases", { method: "POST", body: { tag_name: manifest.tag, target_commitish: manifest.sourceSha, name: manifest.title, body, draft: true, prerelease: manifest.prerelease, make_latest: "false" } });
  if (release.assets.some(asset => !files.has(asset.name))) throw new Error("Draft contains unexpected assets; inspect it before recovery");
  for (const [name, bytes] of files) {
    const existing = release.assets.find(asset => asset.name === name);
    if (existing) {
      if (existing.size !== bytes.length || existing.digest !== `sha256:${digest(bytes)}` || existing.state !== "uploaded") throw new Error("Draft asset differs; existing assets will not be replaced");
      continue;
    }
    const uploadUrl = new URL(release.upload_url.split("{")[0]);
    if (uploadUrl.origin !== "https://uploads.github.com") throw new Error("Unexpected release upload host");
    uploadUrl.searchParams.set("name", name);
    await api(uploadUrl.href, { method: "POST", bytes, contentType: name.endsWith(".exe") ? "application/octet-stream" : "text/plain" });
  }
  release = await api(`/releases/${release.id}`);
  validateArtifacts(manifest.windowsVersion, release.assets.map(asset => asset.name));
  for (const asset of release.assets) {
    const bytes = files.get(asset.name);
    if (asset.size !== bytes.length || asset.digest !== `sha256:${digest(bytes)}` || asset.state !== "uploaded") throw new Error("Uploaded asset verification failed; draft preserved");
  }
  releaseDisposition(manifest, await resolveTag(api, manifest.tag), release);
  return api(`/releases/${release.id}`, { method: "PATCH", body: { name: manifest.title, body, draft: false, prerelease: manifest.prerelease, make_latest: manifest.makeLatest } });
}
