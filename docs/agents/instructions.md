# Agent instruction maintenance

[AGENTS.md](../../AGENTS.md) is the portable entry point. Read its required rules and every matching scope/skill row explicitly when the host does not discover them automatically.

## Canonical files and compatibility

- Maintain the ten shared policies in `.agents/rules/*.md` and the eight skill packages in `.agents/skills/*/SKILL.md`.
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

- Check that all root rule/skill links, forwarding targets, and supporting relative Markdown links resolve with exact filename case.
- Check that all eight skill names match their lowercase directory names, descriptions remain useful, and supporting assets survive the move.
- Compare Cursor adapter metadata with the root applicability table when changing scopes.
- Exercise routing for engine work, editor UI, docs creation, pure-logic tests, investigation, and review. Confirm read-only requests do not trigger writes and planning can return a plan.
- In each intended client, start a fresh session and ask it to identify the applicable rules and skill paths for those scenarios. Record actual client results; static link checks do not prove automatic discovery.
- Pass `pnpm verify` before opening any PR, including drafts. If verification or client access is unavailable, disclose that limitation and retain the compatibility entry points.

## PR delivery

Agents own delivery through merge: local tests and full `pnpm verify` first, then open a draft, wait for a free Verify slot, mark ready, and monitor CI. On failure, inspect logs, fix the cause, pass local verification, push, and wait for the new run. Merge only the verified current head once all required checks and branch protections pass, and confirm the merged state. Missing tooling should be repaired where possible; an unresolved blocker must be reported, never treated as a successful test. See [the workflow](../../.agents/rules/agent-workflow.md) and [PR cadence](../../.agents/rules/github-actions-pr-cadence.md) for the authoritative gates.

## Migration validation record

- The active T3 Code/Codex runtime discovered all eight canonical skills from `.agents/skills/` during the migration. This confirms discovery in that runtime; fresh-session Cursor behavior and other clients have not been exercised.
- Static checks confirmed all ten Cursor rule activation headers were preserved, their original path patterns appear in root routing, and all eight forwarding descriptions match their canonical skills.
- All 171 checked local instruction/migration links resolved with exact filename case. The 44 supporting files that were moved without edits retained their Git blob hashes; the meshes reference received a broken-link correction.
- Skill frontmatter was checked with Node and a YAML parser because Python was unavailable for the skill-creator validator. This check covers names, required descriptions, supported keys, and length limits.
