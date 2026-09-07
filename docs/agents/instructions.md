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

The Babylon skill includes a legacy `babylonjs.skill` archive. It contains an older entry point and seven references, omitting the procedural-modeling reference. Retain it for provenance only; the unpacked package is authoritative.

## Validation

- Check that all root rule/skill links, forwarding targets, and supporting relative Markdown links resolve with exact filename case.
- Check that all eight skill names match their lowercase directory names, descriptions remain useful, and supporting assets survive the move.
- Compare Cursor adapter metadata with the root applicability table when changing scopes.
- Exercise routing for engine work, editor UI, docs creation, pure-logic tests, investigation, and review. Confirm read-only requests do not trigger writes and planning can return a plan.
- In each intended client, start a fresh session and ask it to identify the applicable rules and skill paths for those scenarios. Record actual client results; static link checks do not prove automatic discovery.
- Run `pnpm verify` before marking the implementation PR ready. If verification or client access is unavailable, disclose that limitation and retain the compatibility entry points.
