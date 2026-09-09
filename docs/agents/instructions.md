# Agent instruction maintenance

[AGENTS.md](../../AGENTS.md) is the portable entry point. Read its required rules and every matching scope/skill row explicitly when the host does not discover them automatically.

Its working agreements apply across clients: clarify ambiguous instructions before proceeding, keep explanation/investigation/review/planning requests read-only unless changes are explicitly requested, and reuse the established components and design. These agreements live in the repository so they do not depend on a developer's Codex-global instructions.

## Canonical files and compatibility

- Maintain the eleven shared policies in `.agents/rules/*.md` and the nine skill packages in `.agents/skills/*/SKILL.md`.
- The root routing table preserves Cursor's original always-applied rules, path patterns, and task triggers. Documentation obligations also apply to behavior changes outside `docs/`.
- `.cursor/rules/*.mdc` retain their original activation metadata and forward to shared rules. `.cursor/skills/*/SKILL.md` are forwarding entry points for existing discovery/invocations; all supporting files live with the canonical skill.
- Edit canonical content. Keep forwarding entry points' names and descriptions consistent with their targets. Do not copy full instructions into adapters or require symlinks on Windows.
- Every skill has portable `name` and `description` frontmatter. Optional `agents/openai.*` files are retained host UI metadata; core instructions do not depend on them. The shadcn host-specific command allowlist and template expansion were replaced by explicit shell instructions; host permissions still govern tools.
- Delegation uses available capabilities and inherited models, with sequential passes when unavailable. The existing hard model allowlist remains in the workflow rule. Cursor-specific model identifiers there are compatibility examples, not required host tool names.
- New branches use `agent/`; existing host-created branches and historical `cursor/` references remain valid.

## Imported skill provenance

`skills-lock.json` records upstream sources and hashes for code-review, shadcn, test-driven-development, and vitest. Preserve those upstream records during local adaptation; they are not checksums of this repository's modified skill bodies. Review an upstream update in a separate diff, merge its relevant changes into the canonical package, and retain repository overrides and compatibility entry points. Do not blindly reinstall over local changes.

The Babylon skill keeps the maintained source files only. Git history preserves the legacy archive; the GUI tutorial is omitted because the game HUD / UserInterface system was removed and editor chrome uses React components.

## Validation

- Before development, match the task and affected files to the skill table, read all applicable skills, and identify their use. Recheck when scope changes; automatically discovering a skill is not evidence that it was applied.
- Engine integration within editor files requires BabylonJS as well as the relevant React UI skills. Load only task-relevant supporting references and verify version-specific examples against installed dependencies.
- Preserve compact desktop Primary buttons, other small controls, margins, and panel spacing. Touch support uses input-specific hit areas or layouts; imported HIG guidance must not enlarge desktop defaults. The broad Apple HIG skill is not installed as a default design authority for this cross-platform editor.

- Check that all root rule/skill links, forwarding targets, and supporting relative Markdown links resolve with exact filename case.
- Check that all nine skill names match their lowercase directory names, descriptions remain useful, and supporting assets remain available.
- Compare Cursor adapter metadata with the root applicability table when changing scopes.
- Exercise routing for engine work, editor UI, docs creation, pure-logic tests, investigation, and review. Confirm read-only requests do not trigger writes and planning can return a plan.
- In each intended client, start a fresh session and ask it to identify the applicable rules and skill paths for those scenarios. Record actual client results; static link checks do not prove automatic discovery.
- Before opening/updating a PR, pass explicit targeted test files/cases and relevant scoped static checks for the change. Instruction/prose-only edits need diff/link review. Public API, lockfile and CI-repair work do not authorize cumulative or workspace-wide checks; broader local runs require an explicit user request. Disclose any unavailable selected check.

## PR delivery

Repository changes are complete only after the PR is confirmed merged into `main`. If an agent ends work or a session with unmerged changes, it must prominently warn that unmerged work remains, identify the branch and PR (or absence of one), and explain the blocker or reason for stopping and remaining merge steps. This also applies to an explicit user hold; it does not override the hold or merge gates. Read-only tasks do not require a PR.

Agents own delivery through merge: integrate main, pass tests targeted to changed behavior and directly affected consumers, then open a draft, wait for a free Verify slot, mark ready, and monitor CI. Use scoped lint/typechecks when relevant; prose-only edits use diff/link review. Do not automatically run the cumulative `pnpm verify:local` diagnostic, full suites, coverage, all browser tests, or workspace-wide typechecks. Broader local runs require an explicit user request, including for public API, lockfile, infrastructure and CI-repair work. After a repair, rerun only affected checks, recording the scope/revision and why any earlier result remains applicable. Required exhaustive CI remains unchanged. Merge only the current head once all CI checks and branch protections pass. Missing or failed selected checks are never treated as successful. See [the workflow](../../.agents/rules/agent-workflow.md) and [PR cadence](../../.agents/rules/github-actions-pr-cadence.md).

The global Codex instructions in `~/.codex/AGENTS.md` use the same targeted-only local policy. Repository rules and imported testing/waiting skills must not silently reintroduce broad verification as a PR prerequisite. Compatibility adapters forward to the canonical rules and need no duplicated policy text.

Global guidance also directs agents to the per-user [local resource configuration](../architecture/testing.md#local-test-execution). Updated Slate worktrees share its low-memory admission and verified artifact cache; existing processes retain the code/settings they started with. Global prose does not enforce limits on unrelated repositories: those need a compatible runner. Preserve other agents' processes and worktrees when adopting the updated runner.

The automatically discoverable [wait-efficiently skill](../../.agents/skills/wait-efficiently/SKILL.md) routes local scripts, Verify CI, and capacity waits through the foreground [agent-wait helper](../../scripts/agent-wait.mjs). Retain one host session; use completion notifications/pending calls when available, otherwise the longest permitted process wait with minimal output. Report start/end and actionable failures, plus host-required updates. Do not repeatedly query GitHub, tail logs, or relaunch tests while it waits. Full logs and working-tree snapshots stay in OS temporary storage; bounded terminal records identify results. Shared local admission permits up to three one-worker phases and uses dedicated smaller reservations for Node tooling and docs; fast mode remains single-agent guidance. T3 Code, dependencies, and the nine-job CI layout are unchanged. The helper adds no daemon, scheduler, or dormant wakeup mechanism.

Validate wait behavior with `pnpm test:agent-wait` (selected locally when related wait code changes and always retained in CI's static job): real fixture processes and a fake GitHub CLI exercise output limits, interruption/descendant cleanup, deadlines, stale source/heads/runs, job gates, and capacity exclusions. Exercise the skill on slow successful and failing commands in the intended client; record actual host wakeups and conversation bytes rather than claiming zero-token waiting. Static skill discovery checks alone do not prove client behavior.

### Waiting validation record

- Windows Codex/T3 process-session exercise, 2026-09-07: the same 24-second, 96-line successful fixture produced 5,846 command-output bytes across three tool returns with short polling, versus 432 bytes across two returns with the helper and one pending 60-second process wait. Counts include initial and terminal returns: intermediate returns fell from two to one. These are observed tool-return counts, not tokenizer measurements or a reconstruction of an earlier session.
- The helper emitted only its two records; all 96 progress lines remained in the local log. A failing fixture reported script exit code 7 with 1,164 bytes of bounded output in one return. Fixture-process and fake-GitHub tests keep individual CLI polls inside the helper, with no model calls and no streamed test logs.
- This host still wakes the model to collect completion and requires updates during longer waits. No zero-token or automatic dormant notification claim is made. The canonical skill was read and exercised directly; fresh-client automatic invocation in Cursor remains untested.

## Migration validation record

- The active T3 Code/Codex runtime discovered all eight canonical skills from `.agents/skills/` during the migration. This confirms discovery in that runtime; fresh-session Cursor behavior and other clients have not been exercised.
- Static checks confirmed all ten Cursor rule activation headers were preserved, their original path patterns appear in root routing, and all eight forwarding descriptions match their canonical skills.
- All 171 checked local instruction/migration links resolved with exact filename case. The 44 supporting files that were moved without edits retained their Git blob hashes; the meshes reference received a broken-link correction.
- Skill frontmatter was checked with Node and a YAML parser because Python was unavailable for the skill-creator validator. This check covers names, required descriptions, supported keys, and length limits.
