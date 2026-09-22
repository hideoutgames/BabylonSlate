# CI performance and reliability

Testing uses standard GitHub-hosted runners in this public repository. No larger runners, paid services, self-hosted migration or billing changes are part of this work. Runner labels are checked by `scripts/workflow-runner-policy.test.mjs`, including local reusable workflows. GitHub documents [standard public-repository runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) separately from [storage billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Account artifact entitlement could not be established with the available billing API access; diagnostic retention remains three days and no paid storage expansion is enabled.

## Local safety is independent

The default local policy is one admitted root and one test worker with at least **2 GiB** headroom, preserving higher host reserves. Local `CI=true` cannot bypass it. Use [resource diagnostics and supported wrappers](architecture/testing.md#local-test-execution); GitHub's parallel machines are not a local concurrency recommendation. Full Windows process-tree supervision, pressure cancellation and qualification of the reported memory failure remain outstanding. Reservations and serialization are risk reduction, not OS memory quotas or proof that the underlying failure is fixed.

## Existing-run baseline, 22 September 2026

The initial cohort contains **25 existing completed PR/main Verify runs** created between 20 September 16:11:46 UTC and 22 September 01:19:40 UTC. No runs were triggered to create it. Of these, **21 succeeded and four failed**. Job pages were complete and attempts were included.

| Measure | Observation |
| --- | ---: |
| Median workflow creation to final job completion, 21 successful runs | 22.22 min |
| Median aggregate execution across all jobs, same successful runs | 114.00 runner-min |
| Median job creation to runner start, 189 successful-run jobs | 3 s |
| Measured execution in seven cancelled runs inside the same date window | 159.67 runner-min |

Workflow latency and aggregate runner work measure different things and must not be added. Job creation-to-start excludes dependency waiting before a dependent job is created. Four cancellation records had completion before start; those invalid durations were excluded, making cancellation work a measured subtotal. Cache temperatures, complete test counts, retry costs and timing-weight fallback coverage have not been established for this cohort. Mixed commits and a small sample do not establish a stable p95 or a speed improvement.

Failed-run classification:

- [35666342933](https://github.com/hideoutgames/BabylonSlate/actions/runs/35666342933): `e2e (6)` failed listing the same-run build artifact with an intermediary HTTP 403; browser tests did not execute. The cause is unresolved. This is infrastructure failure, not a test regression, and does not justify broader PR privileges.
- [35633809373](https://github.com/hideoutgames/BabylonSlate/actions/runs/35633809373) and [35630555202](https://github.com/hideoutgames/BabylonSlate/actions/runs/35630555202): editor DOM assertion failures in `homepage-mobile-account-gate.test.tsx`.
- [35521943717](https://github.com/hideoutgames/BabylonSlate/actions/runs/35521943717): browser assertion failure in `qa-animation-overlap.spec.ts`, including retries. This classification alone does not diagnose a regression or flake.

## Independent browser build pilot

Verify starts `static`, `unit`, and `e2e (1)` through `e2e (7)` independently on separate standard Ubuntu machines. Each shard builds player then editor sequentially before running its unchanged timing-weighted partition with one Playwright worker. The CI-only `BL_TEST_BUILD_MODE=ci-bundle` contract does not assert that typechecking passed: the required `static` job still owns tooling, distribution contracts, workspace typechecking, lint and docs. A static failure therefore prevents merge even if browsers pass.

The old shared build upload/download and the browser dependency on `static` are removed. This keeps nine Verify jobs and removes the shared-artifact transport dependency. It also removes the one-day browser-build rerun input; a delayed shard rerun builds from its checked-out source. Diagnostic reports retain their existing three-day policy. Build source, environment, installed toolchain and file-integrity validation remain in place. Bundle-only artifacts have a distinct identity from standalone typechecked builds, and local selection of CI bundle-only mode fails before compilation.

A zero browser exit code is accepted only with a JSON report bearing this invocation's server nonce and containing executed passing tests. Missing/stale reports, all-skipped selections, runner errors and unexpected outcomes fail. Existing skips and retry outcomes remain visible in a compact result log; reports never replace required browser execution.

This is a provisional pilot, not a measured speedup. Earlier post-typecheck builds took 8–10 seconds, but independent cold builds must be measured. Compare full required-check latency, queue delay, aggregate runner seconds, retries, failures, test inventory and build duration against the control, recording exact source, lockfile, Node and runner image. Starting browsers early can consume work when static later fails. Keep the existing two-ready-PR admission cadence and treat 20 jobs as the repository's planning budget; actual account concurrency and overlapping main/Preview/Security activity must be observed.

Accept the pilot only if repeated comparable runs preserve complete execution and show a useful latency/reliability benefit for the extra builds. A 15% median reduction is an initial target, not a forecast. Cold/warm comparisons and broader live observations remain necessary; no full local suite is required for this measurement.

## Rollback

Revert the independent-startup change to restore the prior shared producer in `static` and its browser dependency if the pilot increases latency, flakiness or resource contention without sufficient benefit. Keep all required checks and the separately delivered local policy, 2 GiB minimum reserve, hosted-context validation and runner allowlist. A performance rollback must not restore local `CI=true` admission bypass. If local ownership is uncertain, retain the blocked lease and establish cleanup; do not disable admission.

## Sample runs

| Run | Outcome | Wall minutes | Runner minutes |
| --- | --- | ---: | ---: |
| [35675338666](https://github.com/hideoutgames/BabylonSlate/actions/runs/35675338666) | success | 22.22 | 114.00 |
| [35666534414](https://github.com/hideoutgames/BabylonSlate/actions/runs/35666534414) | success | 21.57 | 106.63 |
| [35666376532](https://github.com/hideoutgames/BabylonSlate/actions/runs/35666376532) | success | 21.58 | 114.83 |
| [35666342933](https://github.com/hideoutgames/BabylonSlate/actions/runs/35666342933) | failure | 21.95 | 94.40 |
| [35647859114](https://github.com/hideoutgames/BabylonSlate/actions/runs/35647859114) | success | 19.97 | 111.47 |
| [35646578116](https://github.com/hideoutgames/BabylonSlate/actions/runs/35646578116) | success | 22.60 | 113.67 |
| [35640730123](https://github.com/hideoutgames/BabylonSlate/actions/runs/35640730123) | success | 24.07 | 119.02 |
| [35638491864](https://github.com/hideoutgames/BabylonSlate/actions/runs/35638491864) | success | 19.83 | 108.42 |
| [35637694505](https://github.com/hideoutgames/BabylonSlate/actions/runs/35637694505) | success | 22.33 | 114.00 |
| [35635678072](https://github.com/hideoutgames/BabylonSlate/actions/runs/35635678072) | success | 23.02 | 117.13 |
| [35635195240](https://github.com/hideoutgames/BabylonSlate/actions/runs/35635195240) | success | 21.87 | 115.20 |
| [35633809373](https://github.com/hideoutgames/BabylonSlate/actions/runs/35633809373) | failure | 22.88 | 115.95 |
| [35630959305](https://github.com/hideoutgames/BabylonSlate/actions/runs/35630959305) | success | 23.67 | 117.38 |
| [35630555202](https://github.com/hideoutgames/BabylonSlate/actions/runs/35630555202) | failure | 21.87 | 102.63 |
| [35630520831](https://github.com/hideoutgames/BabylonSlate/actions/runs/35630520831) | success | 22.42 | 115.48 |
| [35626820043](https://github.com/hideoutgames/BabylonSlate/actions/runs/35626820043) | success | 21.75 | 110.60 |
| [35623689287](https://github.com/hideoutgames/BabylonSlate/actions/runs/35623689287) | success | 21.48 | 111.78 |
| [35552333404](https://github.com/hideoutgames/BabylonSlate/actions/runs/35552333404) | success | 22.12 | 116.97 |
| [35549811711](https://github.com/hideoutgames/BabylonSlate/actions/runs/35549811711) | success | 22.42 | 112.80 |
| [35527729154](https://github.com/hideoutgames/BabylonSlate/actions/runs/35527729154) | success | 23.53 | 124.28 |
| [35526426079](https://github.com/hideoutgames/BabylonSlate/actions/runs/35526426079) | success | 21.28 | 114.67 |
| [35525490687](https://github.com/hideoutgames/BabylonSlate/actions/runs/35525490687) | success | 23.15 | 105.45 |
| [35524923915](https://github.com/hideoutgames/BabylonSlate/actions/runs/35524923915) | success | 22.07 | 109.00 |
| [35524048233](https://github.com/hideoutgames/BabylonSlate/actions/runs/35524048233) | success | 23.05 | 112.35 |
| [35521943717](https://github.com/hideoutgames/BabylonSlate/actions/runs/35521943717) | failure | 22.82 | 118.22 |
