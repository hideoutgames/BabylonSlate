# Docs site

`docs/` is the VitePress content root and `apps/docs/` the site app. URLs mirror folders: `docs/scripting/class/branch.md` is `/scripting/class/branch`. `docs/index.md` is the home page; each category folder has an `index.md` landing page. Reference folders hold one page per item: `components/`, `assets/` and `scripting/<graph>/`.

## Sidebar

[`apps/docs/src/sidebar.ts`](../../apps/docs/src/sidebar.ts) builds it. Adding or removing a guide page means editing the list in `guideSidebar()`; its label is the page's `#` heading. A reference page appears when its folder's `index.md` links it under a `## Group` heading. Unreachable pages fail `sidebar.test.ts`, and dead links fail the build.

## Node reference pages

Every page under `scripting/<graph>/` except `index.md` starts with frontmatter naming its catalog node, such as `node: flow.branch`, and its Inputs and Outputs rows are exactly that node's pins: the editor's pin names, with Class and Animation flow pins named `exec` and `then` listed as **In** and **Out**. The build draws Class and Material nodes with the editor's own graph components and puts each pin's glyph before its type ([`apps/docs/scripts/node-previews.mjs`](../../apps/docs/scripts/node-previews.mjs), which the `dev` and `build` scripts run first). It fails on an unknown `node:` or a row that is not a pin, and `node-pages.test.ts` fails when a catalog node has no page.

## Checks

- Prose-only edits: review the diff and links.
- New, moved or deleted pages, or `apps/docs/` changes: run `apps/docs/src/sidebar.test.ts`, `apps/docs/src/heading-fragments.test.ts` and, for node pages or graph node components, `apps/docs/src/node-pages.test.ts`; then `pnpm --filter docs-site build`.
