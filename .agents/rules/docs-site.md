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

## Node reference pages

Pages under `scripting/<graph>/` (except `index.md`) start with frontmatter naming their catalog node, such as `node: flow.branch`. The build draws that node with the editor's own graph components under the page summary, and puts the graph's pin glyph before each type in the Inputs and Outputs tables.

- [`apps/docs/scripts/node-previews.mjs`](../../apps/docs/scripts/node-previews.mjs) renders every catalog node ([`src/node-previews/render.tsx`](../../apps/docs/src/node-previews/render.tsx)) and compiles the Tailwind utilities and editor tokens they use, scoped to `.haptic-graph`, into `.vitepress/cache/node-previews/`. The `dev` and `build` scripts run it first.
- [`src/node-previews/markdown.ts`](../../apps/docs/src/node-previews/markdown.ts) fails the build when a page's `node:` is not in its graph's catalog or a table row is not one of the node's pins. Class and Animation flow pins named `exec` and `then` are listed as **In** and **Out**; other rows use the editor's pin name.
- `apps/docs/src/node-pages.test.ts` fails when a node page has no `node:` or a catalog node has no page.

## Checks

- Prose-only edits: review the diff and links.
- New, moved or deleted pages, or `apps/docs/` changes: run `apps/docs/src/sidebar.test.ts` and `apps/docs/src/heading-fragments.test.ts`, then `pnpm --filter docs-site build`.
- Node pages, `apps/docs/src/node-previews/` or graph node component changes: also run `apps/docs/src/node-pages.test.ts`, then build.
