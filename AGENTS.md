# Agent instructions

Agent workflow, git automation, and architecture rules live in `.cursor/rules/agent-workflow.mdc` (always applied).

The engine architecture and delivery plan is in [docs/engineplan.md](docs/engineplan.md).

Subagent model allowlist (hard): Task / subagents may inherit, or use Composer 2.5 / Grok 4.5 / Grok 4.6 at low, medium, high, or extra-high — never Fast. Claude/Sonnet and other families are forbidden. Details in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

Never AI-generate artwork, videos, icons, 3D models, or similar media. Details in [.cursor/rules/no-ai-artwork.mdc](.cursor/rules/no-ai-artwork.mdc).
