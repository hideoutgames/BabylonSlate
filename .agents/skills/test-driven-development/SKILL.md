---
name: test-driven-development
description: Use when implementing features or bug fixes to select focused tests that protect production behavior and plausible functionality regressions.
---

# Regression-focused development

Use tests to protect the behavior people rely on in the editor and game runtime. The skill retains its existing name for compatibility; strict test-first ordering is not a local requirement.

## Choose the order that helps the task

- Read the relevant implementation and existing coverage, then identify the behavior that could regress.
- For a reproducible bug, prefer a small failing regression test when it helps confirm the cause. Tests may also be written or extended after implementation; no permission or exception is needed for that ordering.
- Do not discard working implementation, add redundant tests, or stop useful implementation work solely because no test has failed yet.
- If local checks are queued or unavailable, continue implementation and review within the authorized scope. Keep the selected verification pending and report the actual limitation. A queue, timeout, or unexecuted test is never a pass.

## Test the production contract

Before adding a test, identify a plausible incorrect behavior it would detect. Prioritize observable outcomes, important invariants, persisted data, public APIs, and directly affected consumers.

- Bug fix: cover the reported failure and any relevant boundary that could reintroduce it.
- New behavior: verify its useful outcome and meaningful error or cancellation paths.
- Runtime or integration change: exercise the real resolver, compiler, serialization, or host boundary involved. When Play and the exported player use different paths, cover the affected paths rather than assuming one proves the other.
- UI behavior: test user interaction and state changes through the real component. Use a targeted browser check when layout, rendered pixels, touch sizing, or focus cannot be established in a DOM unit test.
- Reversible cosmetic changes and documentation usually need focused inspection, not new application tests. Reuse existing coverage when it already protects the contract.

Read [writing-good-tests.md](writing-good-tests.md) when writing or changing tests. Avoid implementation-mirroring assertions, duplicate cases, trivial constant checks, and tests added only to raise coverage. Mock external boundaries only where needed; preserve the production behavior being checked.

## Keep local verification proportionate

Follow the [repository workflow](../../rules/agent-workflow.md) and [wait-efficiently skill](../wait-efficiently/SKILL.md):

1. Select explicit test files or cases for the changed behavior and directly affected consumers. Inspect command selectors before running them.
2. Run relevant scoped lint or typechecks when justified. Instruction/prose-only changes use diff and link checks.
3. Preserve shared resource admission and `BL_TEST_PROFILE=shared`. Do not change reservations, bypass the queue, increase workers, or stop other agents' processes to make a test run sooner.
4. Diagnose failures and rerun only checks affected by the repair. Reuse results for unchanged behavior with a recorded scope and revision.

Do not automatically run full suites, coverage sweeps, all browser tests, workspace-wide typechecks, or cumulative preflight. Broader local verification requires an explicit user request. Required CI and merge gates remain unchanged.

## Report evidence accurately

Record the selected commands, scope, revision, and results. Distinguish observed failing regressions, passing checks, and checks that did not run. Never claim a test failed before implementation if it was first executed afterward.

Before delivery, assess whether the selected evidence protects the actual production behavior and whether any relevant path remains unverified. Follow the repository's PR and merge requirements; permitting implementation before tests does not waive verification or authorize distribution.
