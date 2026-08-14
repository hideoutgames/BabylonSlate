# Agent instructions

Agent workflow, git automation, and architecture rules live in `.cursor/rules/agent-workflow.mdc` (always applied).

The engine architecture and delivery plan is in [docs/engineplan.md](docs/engineplan.md).

Subagent model allowlist (hard): Task / subagents may inherit, or use Composer 2.5 / Grok 4.5 / Grok 4.6 (Grok at any effort level, including Fast). Claude/Sonnet, Composer Fast, and other families are forbidden. Details in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
