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

Operating model (engineplan §16.1):

- **One slice, one PR, one owner** per package set. Two agents never hold the same package at once — this is why the package boundaries are drawn narrowly.
- **API before implementation.** A slice others depend on lands its types and a failing test suite first, so downstream agents can start against a stable signature instead of guessing.
- **Design notes for shared surfaces.** Shared surfaces (bridge protocol, container formats) get a design note in `docs/architecture/` before parallel implementation starts.
