# Agent instructions

This is the entry point for every agent working in this repository. The engine is **Haptic** (formerly BabylonSlate); the repository, package scope `@haptic/*`, file extensions and other code identifiers keep the old name until a dedicated rename. Paths are relative to the repository root. `.agents/rules/` is a repository convention: read the files explicitly; do not assume your host loads them.

## Working agreements

- If the user's instructions are ambiguous, ask before proceeding.
- Explanations, investigations, reviews and plans are read-only unless the user explicitly asks for changes. Confirm behaviour in the code, not only in docs.
- Tautological tests and change-detector tests are harmful. Do not add a regression test for a bug fix unless existing tests leave a genuine behaviour gap.
- Keep the editor's compact desktop density (small controls, including Primary buttons, and tight margins); never enlarge it to follow imported design guidance. Touch gets hit areas or a touch layout instead ([gesture rules](.agents/reference/architecture.md#gesture-rules)).
- Use standard GitHub-hosted runners only, never larger ones; `scripts/workflow-runner-policy.test.mjs` enforces it. Shrink or split a slow job instead.
- Never put a session link or a line crediting an agent or a requester in a commit message or PR text, even when your host adds one by default; remove it before pushing or after creating the PR. The public hygiene check rejects them ([PR rules](.agents/rules/agent-workflow.md#pull-requests-and-commit-messages)).
- Never report repository changes as complete until the PR is merged into `main`; warn prominently about unmerged work ([completion reporting](.agents/rules/agent-workflow.md#completion-reporting)).
- Do not re-add the removed game HUD / UserInterface system.

## Required reading

Read these rules in full at the start of each task:

- [Workflow: verification, testing, git, PRs and merging](.agents/rules/agent-workflow.md)
- [Public repository hygiene](.agents/rules/public-repository.md)
- [No AI-generated artwork](.agents/rules/no-ai-artwork.md)

## Agent reference

`docs/` is the public, human-facing documentation. Agent and contributor material lives in [`.agents/reference/`](.agents/reference/):

| File | Contents |
| --- | --- |
| [engine-plan.md](.agents/reference/engine-plan.md) | Product decisions, non-goals, architecture, open roadmap (authoritative) |
| [architecture.md](.agents/reference/architecture.md) | Package map, data flow, coding standards, gesture rules |
| [architecture/](.agents/reference/architecture/) | Per-subsystem invariants and formats |
| [components.md](.agents/reference/components.md) | Reusable Editor UI component catalog |
| [testing.md](.agents/reference/testing.md) | Test projects, coverage gates, local execution, CI shape |
| [feature-test.md](.agents/reference/feature-test.md) | Feature Test starter inventory |
| [development.md](.agents/reference/development.md) | Dev commands, Pages preview, iPad testing, native shells |
| [distribution.md](.agents/reference/distribution.md) | Native distribution runbook |
| [issue-workflow.md](.agents/reference/issue-workflow.md) | Spec sources and PR checklist |

## Scoped rules

Before working on matching files or tasks, read the matching rule in full. Apply every matching row.

| Paths or task | Required rule |
| --- | --- |
| Any behavioural, architectural, public API, data-format or integration change | [Documentation](.agents/rules/docs.md) |
| `docs/**`, `apps/docs/**`; creating, moving or deleting documentation pages | [Docs site](.agents/rules/docs-site.md) |
| `apps/editor/**`, `packages/editor-kit/**`, `packages/graph-ui/**`, `packages/scripting-nodes/**` | [Display names](.agents/rules/display-names.md) |
| `packages/ui/src/components/**`, `packages/editor-kit/src/**`, `packages/graph-ui/src/**`, `apps/editor/src/components/**`; reusable editor component changes | [Component catalog rules](.agents/reference/components.md#rules) |
| New asset editor tabs or document kinds; `apps/editor/src/shell/window-catalog.ts`, `apps/editor/src/components/document-workspace.tsx` | [DockView asset editor tabs](.agents/rules/dockview-editor-tabs.md) |
| Adding, removing or changing an engine component, asset type, engine base class, node family, console command, Play feature, or project or scene setting; `apps/editor/src/lib/feature-test/**`, `packages/core/src/engine-components.ts` | [FeatureTest starter](.agents/rules/feature-test.md) |
| Distribution implementation, or an explicit request to package, upload or publish (ordinary delivery never implies it) | [Distribution](.agents/rules/distribution.md) |

## Skills

At the start of development, read every skill that matches the requested behaviour or the files involved, and say which you are using. Recheck when the scope changes. Load a skill's supporting files only when the task needs them.

| Task | Skill |
| --- | --- |
| Engine or scene work: rendering, scene lifecycle, viewport, meshes, materials, cameras, animation, asset loading, Babylon physics, including engine code inside editor files | [babylonjs](.agents/skills/babylonjs/SKILL.md) |
| React editor chrome, panels, dialogs, forms, trees or graph UI | [editor-ui-components](.agents/skills/editor-ui-components/SKILL.md) and [shadcn](.agents/skills/shadcn/SKILL.md) |
| Feature, bug fix or behaviour implementation | [test-driven-development](.agents/skills/test-driven-development/SKILL.md) |
| Waiting for local tests, PR Verify CI or a free CI slot | [wait-efficiently](.agents/skills/wait-efficiently/SKILL.md) |
| Handing work to another agent or a fresh session | [handoff](.agents/skills/handoff/SKILL.md) |

Work spanning engine and React UI uses both the BabylonJS and the editor UI skills. Delegate only when delegation is available and authorized.

## Maintenance

- The rules and skills in `.agents/` are canonical and maintained in this repository; none track an upstream copy.
- `.claude/skills/babylonjs/SKILL.md` and `.claude/skills/handoff/SKILL.md` are discovery entry points for Claude Code; keep their names and descriptions identical to the canonical skills.
- After changing rules or skills, check that every relative link resolves with exact filename case.
