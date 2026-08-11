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
| 2026-08-11 | cursor/p3-object-model-e177 / cursor/p3-spawn-deferral-e177 | p3-object-model | Standards | `spawnActorNow` ignored mid-tick and committed immediately (doc requires deferral) | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 / cursor/p3-spawn-deferral-e177 | p3-object-model | Standards | Doc listed `TickScheduler`; exports are `TickClock` / `TICK_PHASES` | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 | p3-object-model / p3-harness | Spec | Acceptance (120-tick golden) met; remaining notes are intentional P3 scope (registry not wired into spawn, World-owned spawn API, flat components, VFS fixture decoupled from scenario) | Accepted |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-play-overlay | Spec | Play uses in-process runtime; `worker-entry.ts` shipped but Vite Worker host wiring deferred (in-process + worker-entry both exist; Playwright exercises overlay) | Accepted |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-render-sync | Standards | Per-frame ActorSlot/Set alloc in snapshot sync — fixed to reuse scratch | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-bridge | Spec | Multi-transport parity harness now exercises SAB + transferable against in-process snapshot payload | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-preview-report | Spec | Navigate focuses fixture node id (full graph/bodyLine navigation waits on P5 compiler) | Accepted |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-input-capture | Spec | Synthetic encode/decode tested; full harness replay-through-runtime deferred with action mappings to P6 | Accepted |

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

## Subagent model preference

When a parent agent launches Task / subagents and chooses a model:

- Prefer **Composer 2.5**. **Composer 2.5 Fast** (`composer-2.5-fast`) is an acceptable default.
- Soft preference only — do not hard-require an explicit Composer model on every Task call. Omitting `model` (inherit parent) is fine.
- Honor an explicit user or task request for another model.
- See [.cursor/rules/agent-workflow.mdc](../../.cursor/rules/agent-workflow.mdc) (Subagent models).

## P1 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Binary VFS | `p1-vfs` | `core`, `vfs` | Design notes |
| App settings | `p1-app-settings` | `vfs` | Design notes |
| Containers + migration | `p1-babasset`, `p1-schema-migration` | `assets`, `test-kit` | `p1-vfs` |
| Project codec | `p1-babproject` | `assets` | babasset |
| Homepage | `p1-homepage` | `apps/editor`, thin `ui`/`editor-kit` | vfs + settings + babproject |

Design notes: [containers.md](../architecture/containers.md), [vfs.md](../architecture/vfs.md).

## P2 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Registry + importers | `p2-registry` | `assets`, `core`, `test-kit` | Design notes |
| Edit / undo | `p2-edit-undo` | `edit`, `apps/editor`, `graph-ui` | Design notes |
| Texture pipeline | `p2-texture-compression` | `assets`, `render`, `test-kit`, `apps/editor/public` | Registry API |
| Content Browser | `p2-content-browser` | `apps/editor`, `editor-kit`, `ui` | Registry |
| Destructive + journal | `p2-destructive-guard` | `assets`, `edit`, `apps/editor`, `ui` | Registry + edit + CB |

Design notes: [command-layer.md](../architecture/command-layer.md), [asset-registry.md](../architecture/asset-registry.md).

## P3 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Core foundations | — | `core` | Design notes |
| Object model | `p3-object-model` | `object-model`, `core` | Design notes + core foundations |
| Deterministic harness | `p3-harness` | `test-kit`, `object-model`, `vfs` | Object model |

Design notes: [object-model.md](../architecture/object-model.md).

## P4 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/bridge.md`, `render.md` | — |
| Bridge | `p4-bridge` | `bridge`, `apps/editor` (COI) | Design notes |
| Runtime | `p4-runtime-worker` | `runtime`, `test-kit` | Bridge |
| Input | `p4-input-capture` | `input`, `apps/editor` | Bridge |
| Render | `p4-render-sync`, `p4-render-on-demand`, `p4-resource-cache` | `render` | Bridge |
| Play + report | `p4-play-overlay`, `p4-preview-report` | `apps/editor`, `runtime` | Runtime + Render + Input |

Design notes: [bridge.md](../architecture/bridge.md), [render.md](../architecture/render.md).
