import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const releasePlatforms = ["windows", "macos", "linux", "android"];
const labels = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android" };

export function platformSummary(needs) {
  if (needs.validate?.result !== "success") return { text: "Request rejected or not validated. No distribution success is claimed. Check that this workflow was dispatched from main and that exact-source checks passed.", complete: false, failed: true };
  const outputs = needs.validate.outputs;
  if (outputs.dry_run === "true") return { text: "Dry run completed. Inputs, source, checks, versions and intended destinations were validated. No native build, signing, upload or publication was performed.", complete: false, failed: false };
  const published = needs["publish-release"]?.result === "success";
  const rows = releasePlatforms.map(platform => {
    const requested = outputs[platform] === "true";
    const outcome = !requested
      ? "Not requested"
      : published
        ? "Published (see release)"
        : needs[platform]?.result === "success"
          ? "Packaged and checked; not published. Preserve the artifact for recovery."
          : "Packaging incomplete or cancelled; not published";
    return `| ${labels[platform]} | ${outcome} |`;
  });
  const appleRequested = outputs.ipados === "true";
  const appleValue = needs.testflight?.outputs?.state;
  const appleState = ["uploaded", "processing", "awaiting-beta-review", "available", "failed"].includes(appleValue) ? appleValue : needs.ipados?.outputs?.uploaded === "true" ? "uploaded" : "failed";
  rows.push(`| iPadOS | ${appleRequested ? appleState : "Not requested"} |`);
  const releaseRequested = releasePlatforms.some(platform => outputs[platform] === "true");
  const appleAccepted = !appleRequested || appleState === "available";
  const complete = (!releaseRequested || published) && appleAccepted;
  const failed = (releaseRequested && !published) || (appleRequested && !["available", "awaiting-beta-review"].includes(appleState));
  return { complete, failed, text: `${complete ? "Requested destinations reached" : "Distribution incomplete or partially complete"}\n\n| Platform | Outcome |\n| --- | --- |\n${rows.join("\n")}\n\nBuild identities are in the platform step summaries. Awaiting Beta App Review is pending, not tester availability. No App Store submission occurred.\n\nConcurrency does not guarantee that every pending request will run. Inspect Actions for queued/cancelled requests; this summary describes this run only.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = platformSummary(JSON.parse(process.env.DISTRIBUTION_RESULTS));
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Platform Outcomes\n\n${report.text}\n`);
  if (report.failed) process.exitCode = 1;
}
