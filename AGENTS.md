# Agent instructions

Agent workflow, git automation, and architecture rules live in `.cursor/rules/agent-workflow.mdc` (always applied).

The engine architecture and delivery plan is in [docs/engineplan.md](docs/engineplan.md).

Subagent model allowlist (hard): Task / subagents may inherit, or use Composer 2.5 / Grok 4.5 / Grok 4.6 at low, medium, high, or extra-high — never Fast. Claude/Sonnet and other families are forbidden. Details in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

Never AI-generate artwork, videos, icons, 3D models, or similar media. Details in [.cursor/rules/no-ai-artwork.mdc](.cursor/rules/no-ai-artwork.mdc).

Never use or enable GitHub Actions larger runners — standard hosted runners only. Details in [.cursor/rules/github-actions-standard-runners.mdc](.cursor/rules/github-actions-standard-runners.mdc).

PRs stay draft until local `pnpm verify` passes; mark ready once **only if fewer than 2 counted non-draft PRs target `main`**. **[#271](https://github.com/hideoutgames/BabylonSlate/pull/271) is excluded** from that cap. Verify is 9 jobs (`static` + unsharded `unit` + 7 e2e shards). If both slots are taken, leave the draft and stop — a human marks ready. Details in [.cursor/rules/github-actions-pr-cadence.mdc](.cursor/rules/github-actions-pr-cadence.mdc).

Follow `.cursor/skills/BabylonJS/SKILL.md` for engine and scene work, and for **UserInterface** work (Babylon GUI). React editor chrome stays on the shadcn / editor-ui-components skills.

Read-only deep codebase investigation uses `.cursor/skills/investigate/SKILL.md` (parent keeps context; more `explore` sub-agents as scope grows). Short Q&A stays on the ask skill.
