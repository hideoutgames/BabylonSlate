# Agent issue tracker

Workflow for autonomous agents and the code-review skill.

## Spec source order

1. GitHub issue / PR reference in commit messages — fetch via `gh issue view` or PR description.
2. Path passed by the user.
3. `docs/engineplan.md` Appendix A checklist item (e.g. `p0-foundation`).
4. Feature doc under `docs/`.

## Recording review findings

When the code-review skill reports Standards or Spec findings:

1. Add a row to the table below (or fix in the same session).
2. Link the PR branch and checklist id.
3. Mark resolved when fixed.

| Date | Branch | Checklist / issue | Axis | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |

## PR checklist

- [ ] Spec identified (engineplan slice or issue).
- [ ] `pnpm verify` green.
- [ ] `docs/` updated if behaviour or APIs changed.
- [ ] Code-review skill run against merge-base; findings recorded here or fixed.
- [ ] Tests added/updated for new behaviour.

## Parallel agents

- One slice, one PR, one owner per package set (see engineplan §16.1).
- Shared surfaces (bridge protocol, container formats): add a design note in `docs/architecture/` before parallel implementation.
