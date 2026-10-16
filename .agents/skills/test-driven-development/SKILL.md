---
name: test-driven-development
description: Use when implementing features or bug fixes to select focused tests that protect production behavior and plausible functionality regressions.
---

# Regression-focused development

Use tests to protect the behaviour people rely on in the editor and game runtime. The skill keeps its name for compatibility; strict test-first ordering is not required here.

## Order

- Read the implementation and its existing coverage, then name the behaviour that could regress.
- Tests may be written before or after the implementation. Do not discard working code, add redundant tests or stall implementation because no test has failed yet.

## Test the production contract

Before adding a test, name a plausible incorrect behaviour it would detect.

- Bug fix: add a regression test only where existing tests leave a genuine behaviour gap; when you add one, confirm it fails before the fix.
- New behaviour: verify its useful outcome and its meaningful error or cancellation paths.
- Runtime or integration change: exercise the real resolver, compiler, serialisation or host boundary. When Play and the exported player take different paths, cover each affected path.
- UI behaviour: test interaction through the real component. Use a targeted browser check when layout, pixels, touch sizing or focus cannot be established in a DOM test.
- Cosmetic changes and documentation usually need inspection, not new tests.

Read [writing-good-tests.md](writing-good-tests.md) when writing or changing tests. Vitest projects, the shared mocks and the jsdom traps that produce false passes are in [testing.md](../../reference/testing.md).

## Verification

Select, run and record checks as [agent-workflow.md](../../rules/agent-workflow.md#verification) requires.
