# Agent instructions

This is the entry point for every agent working in BabylonSlate. Paths below are relative to the repository root. `.agents/rules/` is a repository convention: read the files explicitly; do not assume your host loads them. Repository policies take precedence over imported skill examples, subject to higher-priority host and user instructions.

## Working agreements

- If the user's instructions are ambiguous, ask them to clarify before proceeding.
- Treat requests for explanations, investigations, reviews, and plans as read-only unless the user explicitly requests changes. Planning may produce an implementation plan without authorizing implementation.
- Reuse existing components and conventions, and preserve the project's established design.
- Never report repository changes as finished or complete until the PR is confirmed merged into `main`. If ending work or a session with unmerged changes, prominently warn that unmerged work remains, identify the branch and PR (or state that no PR exists), and explain what remains before merge. See the workflow's completion reporting rules below.

## Required reading

Read these rules in full at the start of each task:

- [Workflow, architecture, verification, git, and model policy](.agents/rules/agent-workflow.md)
- [No AI-generated artwork](.agents/rules/no-ai-artwork.md)
- [Standard GitHub runners only](.agents/rules/github-actions-standard-runners.md)
- [PR cadence](.agents/rules/github-actions-pr-cadence.md)
- [DockView asset editor tabs](.agents/rules/dockview-editor-tabs.md)

Never generate artwork or use larger GitHub runners. Pass local `pnpm verify` before opening any PR, including drafts. Mark ready once when fewer than two counted non-draft PRs target `main` (#271 is excluded); if both slots are occupied, keep the draft and wait for a slot. Monitor CI, fix failures with local verification before each repair push, and merge automatically once the current head passes all gates. Public PR descriptions contain only a short change summary, without attribution, session links, secrets, or logs.

The authoritative architecture and delivery plan is [docs/engineplan.md](docs/engineplan.md). Do not re-add the removed game HUD / UserInterface system.

## Scoped rules

Distribution implementation and explicitly requested packaging/upload/publication must follow [Distribution](.agents/rules/distribution.md). Ordinary delivery never implies permission to distribute.

Before working on matching files or tasks, read the corresponding rule in full. Patterns are relative to the repository root; `**` includes descendants. Apply every matching row, including task triggers when no path matches yet.

| Paths or task | Required rule |
| --- | --- |
| Any behavioral, architectural, public API, data-format, or integration change, even outside `docs/` | [Documentation](.agents/rules/docs.md) |
| `docs/**/*.md`, `apps/docs/src/sidebar.ts`; creating documentation pages | [Docs site](.agents/rules/docs-site.md) |
| `apps/editor/**`, `packages/editor-kit/**`, `packages/graph-ui/**`, `packages/scripting-nodes/**` | [Display names](.agents/rules/display-names.md) |
| `packages/ui/src/components/**`, `packages/editor-kit/src/**`, `packages/graph-ui/src/**`, `apps/editor/src/components/**`, `docs/architecture/components.md`; reusable editor component changes | [Component catalog](.agents/rules/editor-ui-components.md) |
| `apps/editor/**`, `packages/ui/**` | [Touch editor](.agents/rules/touch-editor.md) |

## Skills

Read the matching `SKILL.md` before task work, then load its supporting references as needed. If the host does not discover `.agents/skills/`, use this table directly. Explicit skill requests select the named skill. Planning requests remain read-only and may produce implementation plans; they do not activate the ask skill's prohibition on planning.

At the start of development, check this table against both the requested behavior and the files involved, read every applicable skill, and briefly identify the skills being used. Recheck when scope changes. Discovery alone does not count as reading or applying a skill. Load supporting references only for the current task.

BabylonJS is required for rendering, scene lifecycle, viewport engine integration, meshes, materials, cameras, animation, asset loading, and Babylon physics work, including engine integration inside editor files. Work spanning engine and React UI uses both BabylonJS and the editor UI skills. Apply repository architecture and installed API versions when using imported examples.

Preserve BabylonSlate's compact desktop controls, including small Primary buttons, and its tight margins and spacing. Imported design guidance must not enlarge these defaults; follow the input-specific guidance in the touch editor rule.

| Task | Skill |
| --- | --- |
| Short read-only question or explanation | [ask](.agents/skills/ask/SKILL.md) |
| Deep read-only investigation, tracing, mapping, or audit | [investigate](.agents/skills/investigate/SKILL.md) |
| Engine or scene work | [babylonjs](.agents/skills/babylonjs/SKILL.md) |
| React editor chrome, panels, dialogs, forms, trees, or graph UI | [editor-ui-components](.agents/skills/editor-ui-components/SKILL.md) and [shadcn](.agents/skills/shadcn/SKILL.md) |
| Feature, bugfix, or behavior implementation | [test-driven-development](.agents/skills/test-driven-development/SKILL.md) |
| Diff review against standards and originating requirements | [code-review](.agents/skills/code-review/SKILL.md) |
| Unit tests, mocking, coverage, or Vitest configuration | [vitest](.agents/skills/vitest/SKILL.md) |
| Waiting for local tests/verification, PR Verify CI, or a free CI slot | [wait-efficiently](.agents/skills/wait-efficiently/SKILL.md) |

Delegate only when available and authorized. Inherit the parent model by default; explicit selections must follow the workflow's hard allowlist. Use sequential passes when delegation is unavailable.

See [agent instruction maintenance](docs/agents/instructions.md) for compatibility, provenance, and validation.
