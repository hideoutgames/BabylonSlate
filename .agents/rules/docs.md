# Documentation

Two audiences, two places:

| Place | Audience | Holds |
| --- | --- | --- |
| `docs/` | People making games with Haptic | How to use the editor and engine: guides, component, asset and node reference. Published as the docs site. |
| `.agents/reference/` | Agents and engine contributors | Architecture, invariants, formats, decisions, catalogs agents maintain. Not published. |

## Mandatory updates

Docs are part of the definition of done. Update them in the same branch/PR; never defer them.

- **User-visible change** (feature, setting, UI name, menu path, default, limit) → update the affected `docs/` pages.
- **Node added, removed, renamed or changed** → update its page under `docs/scripting/<graph>/` (`class`, `material`, `particle`, `animation`, `behaviour-tree`) and the graph's `index.md`. Pin tables must match the catalog.
- **Engine component or asset type added or removed** → add or remove its page under `docs/components/` or `docs/assets/` and its row in that folder's `index.md`.
- **Architecture, data format, invariant or integration change** → update the matching file in `.agents/reference/` (`engine-plan.md`, `architecture.md`, `architecture/<subsystem>.md`).
- **Reusable Editor UI** change → update `.agents/reference/components.md` ([editor-ui-components.md](editor-ui-components.md)).
- **Removed feature** → delete its pages and every link to them. No stale docs.

## Writing user docs

- Plain, calm, concise. Second person, present tense, active voice. Short paragraphs, bullets and small tables.
- One `#` heading per page; `##` sections in sentence case; UI names exactly as the editor shows them, in **bold** on first use.
- Say "Haptic" or "the editor". Never mention package names, source paths, internal ids, codegen, phase labels, PR numbers or unfinished work.
- Link relatively between `.md` pages; never link source code. No generated images ([no-ai-artwork.md](no-ai-artwork.md)).
- Prefer updating an existing page over adding one. New pages follow [docs-site.md](docs-site.md).

## Writing agent reference

- Terse: invariants, ownership, data flow, formats, decisions with one-line reasons, pointers to source.
- No history, dates, status logs or measurement records; git history keeps those.
