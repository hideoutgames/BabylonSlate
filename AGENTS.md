# Agent instructions

Agent workflow, git automation, and architecture rules live in `.cursor/rules/agent-workflow.mdc` (always applied).

The engine architecture and delivery plan is in [docs/engineplan.md](docs/engineplan.md).

Subagent model preference (soft): prefer Composer 2.5 or Grok 4.6 (any effort, not Fast) when choosing a model for Task subagents; inherit is fine — do not hard-require an explicit slug. Details in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
