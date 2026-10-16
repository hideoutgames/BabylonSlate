# Issue Workflow

Where an agent finds the spec for a change, what a PR must satisfy, how parallel agents divide work, and standing guards against rebuilding settled systems.

## Spec source order

Use the first source that exists; the [code-review skill](../skills/code-review/SKILL.md) uses the same order for its Spec axis.

1. Issue or PR references in commit messages or the request (`#123`, `Closes #45`). Fetch them with `gh issue view <n>` / `gh pr view <n>` (or the GitHub integration), including the description and acceptance notes.
2. A path the user passed.
3. A spec file under `docs/`, `specs/` or `.scratch/` matching the branch or feature, then the matching section of [engine-plan.md](engine-plan.md) or a note under [architecture/](architecture/).
4. Nothing found: ask the user. If there is no spec, a review reports "no spec available" for the Spec axis.

[engine-plan.md](engine-plan.md) stays authoritative for product decisions, non-goals and intended behaviour. If a spec contradicts it, or two sources disagree, ask before implementing.

## Reviews

- A review is read-only. Report Standards and Spec findings separately in the review itself; do not edit files, record findings or publish comments unless the user asks for that.
- There is no standing findings log. When the user asks for findings to be recorded, record them where the user directs; when the user asks for fixes, fix them in the same change.
- Reviewing your own branch before marking a PR ready follows the same two-axis process; fix what it finds rather than logging it.

## PR checklist

- [ ] Spec identified (source order above) and every matching rule and skill from [AGENTS.md](../../AGENTS.md) read.
- [ ] Targeted local tests for the changed behaviour and directly affected consumers, plus relevant scoped static checks, pass on the current revision. No full suites, coverage, all browser tests, workspace typechecks or `pnpm verify:local` unless the user asked ([agent-workflow.md](../rules/agent-workflow.md#verification)). Prose-only edits get diff and link review instead.
- [ ] New behaviour in `packages/*` has meaningful tests; no tautological or change-detector tests, and no regression test for a bug fix without a genuine behaviour gap.
- [ ] `docs/` and `.agents/reference/` updated in the same change ([docs.md](../rules/docs.md)); the FeatureTest starter updated when [feature-test.md](../rules/feature-test.md) applies.
- [ ] Diff self-reviewed against the merge-base on both axes; findings fixed.
- [ ] PR description is a short change summary (session link optional): no attribution footers, secrets or logs ([public-repository.md](../rules/public-repository.md)).
- [ ] Opened as a draft; marked ready once, only when fewer than four counted non-draft PRs target `main` (#271 excluded) ([PR cadence](../rules/github-actions-pr-cadence.md)).
- [ ] Merged only when every merge gate passes, including the latest PR Verify run; work is not reported complete until GitHub confirms the merge ([agent-workflow.md](../rules/agent-workflow.md#completion-reporting)).

## Parallel ownership

- **One slice, one PR, one owner** per package set. Two agents never hold the same package at once; package boundaries are drawn narrowly for this reason.
- **Contract before implementation.** A slice others depend on lands its types and contract tests first, so downstream work starts against a stable signature. The package that owns a shared contract (graph IR, bridge protocol, container format) defines it; consumers never build against a competing shape.
- **Design note before parallel work** on a shared surface: write or update the note under [architecture/](architecture/) before splitting implementation.
- Delegate only when delegation is available and authorized; otherwise run sequential passes.

## Standing guards

- Do not re-add the game HUD / UserInterface system: no `@babylonslate/ui-runtime`, UserInterface assets, WidgetComponent, `ui.*` nodes, Interface-domain materials, Designer / Logic editors or Play/player Babylon GUI ([engine-plan.md](engine-plan.md)).
- Do not rebuild shipped packages or systems to close a gap (`shader-graph`, `anim-graph`, `scripting`, `physics`, `debugger`, `behaviour-tree`, `navigation`, and the systems engine-plan lists as shipped). Wire hosts in `apps/editor` and bind the existing `render` / `runtime` helpers; additive work extends a system without reopening or replacing it.
- Do not start parked polish unless asked: pin flash on tap-to-navigate, behaviour-tree collapse-inactive-subtree and capped auto-layout.
- Do not change a performance-motivated default (for example sprite and tilemap alpha test vs blend) without on-device measurements on the baseline device.
- Never dirty-skip or freeze a visible editor viewport.
- Hardware-only checks (A16 frame rate, WKWebView behaviour, physical-device storage, two-device lock visibility) stay open work until run on hardware; never report them as passed from desktop, emulation or CI runs.
- Never generate artwork, placeholders included ([no-ai-artwork.md](../rules/no-ai-artwork.md)).
