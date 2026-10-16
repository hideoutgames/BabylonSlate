# Docs site

`docs/` is the VitePress content root; the site app lives in `apps/docs/`. URLs mirror folders: `docs/scripting/class/branch.md` → `/scripting/class/branch`.

## Structure

- `docs/index.md` is the home page. Each category folder has an `index.md` landing page (`/physics/`).
- Guide categories: `start`, `editor`, `projects`, `scenes`, `scripting`, `graphics`, `physics`, `audio`, `2d`, `ai`, `input`, `debugging`, `publishing`.
- Reference folders, one page per item: `components/`, `assets/`, `scripting/class/`, `scripting/material/`, `scripting/particle/`, `scripting/animation/`, `scripting/behaviour-tree/`.

## Sidebar

[`apps/docs/src/sidebar.ts`](../../apps/docs/src/sidebar.ts) builds it:

- **Guide pages** are listed by name in `guideSidebar()`. Adding or removing a guide page means editing that list. Labels come from each page's `#` heading.
- **Reference folders** build their sidebar from the folder's `index.md`: each `## Group` heading becomes a group holding the folder pages linked under it. Adding a reference page means adding its link to the right group in that `index.md`.

`apps/docs/src/sidebar.test.ts` fails when a page is unreachable from the sidebar or a sidebar link has no page. The build fails on dead links.

## Checks

- Prose-only edits: review the diff and links.
- New, moved or deleted pages, or `apps/docs/` changes: run `apps/docs/src/sidebar.test.ts` and `apps/docs/src/heading-fragments.test.ts`, then `pnpm --filter docs-site build`.
