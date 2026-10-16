# Documentation

| Place | Audience | Holds |
| --- | --- | --- |
| `docs/` | People making games with Haptic | How to use the editor and engine: guides and component, asset and node reference. Published as the docs site. |
| `.agents/reference/` | Agents and engine contributors | Architecture, invariants, formats, decisions and catalogs. Not published. |

## Update in the same PR

Docs are part of done; never defer them.

- **User-visible change** (feature, setting, UI name, menu path, default, limit): update the affected `docs/` pages.
- **Node added, removed, renamed or changed**: update its page under `docs/scripting/<graph>/` and the graph's `index.md` ([node reference pages](docs-site.md#node-reference-pages)).
- **Engine component or asset type added or removed**: add or remove its page under `docs/components/` or `docs/assets/` and its row in that folder's `index.md`.
- **Architecture, data format, invariant or integration change**: update the matching file in `.agents/reference/`.
- **Reusable Editor UI change**: update [components.md](../reference/components.md#rules).
- **Removed feature**: delete its pages and every link to them.

## Writing user docs

- Plain, calm and concise: second person, present tense, active voice, short paragraphs, bullets and small tables.
- One `#` heading per page and `##` sections in sentence case. UI names exactly as the editor shows them, in **bold** on first use; the side panel for the selection is always the **Inspector**.
- Say "Haptic" or "the editor"; never mention package names, source paths, internal ids, phase labels, PR numbers or unfinished work. Link relatively between pages, never to source code.
- Prefer updating an existing page to adding one; new pages follow [docs-site.md](docs-site.md).

## Writing agent reference

Terse: invariants, ownership, data flow, formats and decisions with one-line reasons, plus pointers to source. No history, dates, status logs or measurements; git keeps those.
