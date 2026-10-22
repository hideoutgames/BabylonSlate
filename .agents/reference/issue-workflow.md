# Issue Workflow

Where an agent finds the spec for a change, what a PR must satisfy, how parallel agents divide work, and standing guards against rebuilding settled systems.

## Spec source order

Use the first source that exists.

1. Issue or PR references in commit messages or the request (`#123`, `Closes #45`). Fetch them with `gh issue view <n>` / `gh pr view <n>` (or the GitHub integration), including the description and acceptance notes.
2. A path the user passed.
3. A page under `docs/` matching the branch or feature, then the matching section of [engine-plan.md](engine-plan.md) or a note under [architecture/](architecture/).
4. Nothing found: ask the user. A review with no spec says so.

[engine-plan.md](engine-plan.md) stays authoritative for product decisions, non-goals and intended behaviour. If a spec contradicts it, or two sources disagree, ask before implementing.

## Reviews

- A review is read-only: check the diff against the repository rules and the spec, report the findings in the review, and edit, record or publish nothing unless the user asks. There is no standing findings log.
- Review your own branch before marking a PR ready, and fix what you find rather than logging it.

## PR checklist

- [ ] Spec identified (source order above) and every matching rule and skill from [AGENTS.md](../../AGENTS.md) read.
- [ ] Verification, tests, docs and the PR description follow [agent-workflow.md](../rules/agent-workflow.md) and [docs.md](../rules/docs.md); the Feature Test starter is updated when [feature-test.md](../rules/feature-test.md) applies.
- [ ] Diff self-reviewed against the merge-base; findings fixed.
- [ ] Draft first, ready once, merged only when every [merge gate](../rules/agent-workflow.md#merge-gates-all-required) passes.

## Parallel ownership

- **One slice, one PR, one owner** per package set. Two agents never hold the same package at once; package boundaries are drawn narrowly for this reason.
- **Contract before implementation.** A slice others depend on lands its types and contract tests first, so downstream work starts against a stable signature. The package that owns a shared contract (graph IR, bridge protocol, container format) defines it; consumers never build against a competing shape.
- **Design note before parallel work** on a shared surface: write or update the note under [architecture/](architecture/) before splitting implementation.

## Standing guards

- Do not re-add the game HUD / UserInterface system: no `@haptic/ui-runtime`, UserInterface assets, WidgetComponent, `ui.*` nodes, Interface-domain materials, Designer / Logic editors or Play/player Babylon GUI ([engine-plan.md](engine-plan.md)).
- Do not rebuild shipped packages or systems to close a gap (`shader-graph`, `anim-graph`, `scripting`, `physics`, `debugger`, `behaviour-tree`, `navigation`, and the systems engine-plan lists as shipped). Wire hosts in `apps/editor` and bind the existing `render` / `runtime` helpers; additive work extends a system without reopening or replacing it.
- Do not start parked polish unless asked: pin flash on tap-to-navigate, behaviour-tree collapse-inactive-subtree and capped auto-layout.
- Do not change a performance-motivated default (for example sprite and tilemap alpha test vs blend) without on-device measurements on the baseline device.
- Never dirty-skip or freeze a visible editor viewport.
- Hardware-only checks (A16 frame rate, WKWebView behaviour, physical-device storage, two-device lock visibility) stay open work until run on hardware; never report them as passed from desktop, emulation or CI runs.
