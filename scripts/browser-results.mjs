import { readFile } from "node:fs/promises";

/** A successful command must leave evidence from this server/test invocation. */
export async function readBrowserResults(path, nonce) {
  const report = JSON.parse(await readFile(path, "utf8"));
  if (!nonce || report.config?.metadata?.testRunNonce !== nonce)
    throw new Error(
      "Browser result report is stale or does not belong to this invocation",
    );
  const stats = report.stats;
  const fields = ["expected", "unexpected", "flaky", "skipped"];
  if (
    !stats ||
    fields.some(
      (field) => !Number.isSafeInteger(stats[field]) || stats[field] < 0,
    )
  )
    throw new Error("Browser result report has invalid outcome counts");
  if (stats.unexpected || report.errors?.length)
    throw new Error(
      "Browser result report contains failed tests or runner errors",
    );
  if (stats.expected + stats.flaky === 0)
    throw new Error("Browser result report contains no executed passing tests");
  return Object.fromEntries(fields.map((field) => [field, stats[field]]));
}
