# Agent instructions

Agent workflow, git automation, and architecture rules live in `.cursor/rules/agent-workflow.mdc` (always applied).

The engine architecture and delivery plan is in [docs/engineplan.md](docs/engineplan.md).

Subagent model allowlist (hard): Task / subagents may inherit, or use Composer 2.5 / Grok 4.5 / Grok 4.6 (not Fast). Claude/Sonnet and other families are forbidden. Details in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
