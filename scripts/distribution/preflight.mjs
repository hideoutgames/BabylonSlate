import { createIdentity, existingAppleIdentity, releaseDisposition, validateChecks, validateSource } from "./contract.mjs";

const VERIFY_JOBS = ["static", "unit", ...Array.from({ length: 7 }, (_, i) => `e2e (${i + 1})`)];

export async function resolveTag(api, tag) {
  let reference = (await api(`/git/ref/tags/${encodeURIComponent(tag)}`, { optional: true }))?.object;
  for (let depth = 0; reference?.type === "tag" && depth < 5; depth++) {
    reference = (await api(`/git/tags/${reference.sha}`)).object;
  }
  if (reference && reference.type !== "commit") throw new Error("Tag does not resolve to a commit");
  return reference?.sha ?? null;
}

export async function preflight(request, { api, git }) {
  const operation = request.operation ?? "distribute";
  if (!["distribute", "finalize-testflight"].includes(operation)) throw new Error("Unsupported distribution operation");
  if (!/^[a-f0-9]{40}$/.test(request.sourceSha)) throw new Error("source_sha must be an exact 40-character commit SHA");
  const main = await api("/branches/main");
  await git(["merge-base", "--is-ancestor", request.sourceSha, "origin/main"]);
  validateSource({ ...request, protectedMain: main.protected, reachable: true });
  const declared = JSON.parse(await git(["show", `${request.sourceSha}:release/version.json`]));
  const identity = operation === "finalize-testflight" ? existingAppleIdentity(declared, request) : createIdentity({ ...request, declaredVersion: declared.version, appleSequenceOffset: declared.appleSequenceOffset });
  if (operation === "distribute" && request.existingBuildNumber) throw new Error("Existing build number is only valid for finalization");
  const runs = await api(`/actions/workflows/verify.yml/runs?head_sha=${identity.sourceSha}&per_page=100`);
  const run = runs.workflow_runs.filter(item => item.head_sha === identity.sourceSha && ["push", "pull_request"].includes(item.event)).sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error("The latest Verify run for this exact source must succeed, for both test and release channels");
  const jobs = await api(`/actions/runs/${run.id}/jobs?per_page=100&filter=latest`);
  validateChecks(identity.sourceSha, jobs.jobs, VERIFY_JOBS);
  const rules = await api("/rules/branches/main");
  const required = new Set(main.protection?.required_status_checks?.contexts ?? []);
  for (const rule of rules) {
    if (rule.type === "required_status_checks") for (const check of rule.parameters.required_status_checks) required.add(check.context);
  }
  if (required.size) {
    const checks = await api(`/commits/${identity.sourceSha}/check-runs?per_page=100&filter=latest`);
    const statuses = await api(`/commits/${identity.sourceSha}/status?per_page=100`);
    const combined = checks.check_runs.sort((a, b) => b.id - a.id);
    for (const status of statuses.statuses) {
      if (!combined.some(check => check.name === status.context)) combined.push({ name: status.context, head_sha: identity.sourceSha, status: "completed", conclusion: status.state });
    }
    validateChecks(identity.sourceSha, combined, [...required]);
  }
  if (request.platforms !== "ipados") {
    const tagSha = await resolveTag(api, identity.tag);
    const release = await api(`/releases/tags/${encodeURIComponent(identity.tag)}`, { optional: true });
    releaseDisposition(identity, tagSha, release);
  }
  return { identity, dryRun: request.dryRun === true, verifyRunId: run.id };
}
