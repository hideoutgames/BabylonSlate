import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function platformSummary(needs) {
  if (needs.validate?.result !== "success") return { text: "Request rejected or not validated. No distribution success is claimed. Check that this workflow was dispatched from main and that exact-source checks passed.", complete: false, failed: true };
  const outputs = needs.validate.outputs;
  if (outputs.dry_run === "true") return { text: "Dry run completed. Inputs, source, checks, versions and intended destinations were validated. No native build, signing, upload or publication was performed.", complete: false, failed: false };
  const windowsRequested = outputs.windows === "true";
  const appleRequested = outputs.ipados === "true";
  const windowsPublished = needs["publish-windows"]?.result === "success";
  const appleValue = needs.testflight?.outputs?.state;
  const appleState = ["uploaded", "processing", "awaiting-beta-review", "available", "failed"].includes(appleValue) ? appleValue : needs.ipados?.outputs?.uploaded === "true" ? "uploaded" : "failed";
  const appleAccepted = ["available", "awaiting-beta-review"].includes(appleState);
  const complete = (!windowsRequested || windowsPublished) && (!appleRequested || appleState === "available");
  const failed = (windowsRequested && !windowsPublished) || (appleRequested && !appleAccepted);
  const windows = !windowsRequested ? "Not requested" : windowsPublished ? "Published (unsigned)" : needs.windows?.result === "success" ? "Packaged and checked; not published. Preserve the artifact identity for recovery." : "Packaging incomplete or cancelled; not published";
  return { complete, failed, text: `${complete ? "Requested destinations reached" : "Distribution incomplete or partially complete"}\n\n| Platform | Outcome |\n| --- | --- |\n| Windows | ${windows} |\n| iPadOS | ${appleRequested ? appleState : "Not requested"} |\n\nBuild identities are in the platform step summaries. Awaiting Beta App Review is pending, not tester availability. No App Store submission occurred.\n\nConcurrency does not guarantee that every pending request will run. Inspect Actions for queued/cancelled requests; this summary describes this run only.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = platformSummary(JSON.parse(process.env.DISTRIBUTION_RESULTS));
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Platform Outcomes\n\n${report.text}\n`);
  if (report.failed) process.exitCode = 1;
}
