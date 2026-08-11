# Agent instructions

Agent workflow, git automation, and architecture rules live in `.cursor/rules/agent-workflow.mdc` (always applied).

The engine architecture and delivery plan is in [docs/engineplan.md](docs/engineplan.md).

Subagent model preference (soft): prefer Composer 2.5 / Composer 2.5 Fast when choosing a model for Task subagents; inherit is fine — do not hard-require an explicit Composer slug. Details in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
