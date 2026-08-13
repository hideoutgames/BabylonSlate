# BabylonSlate documentation

Live site: **[https://hideoutgames.github.io/BabylonSlate/docs/](https://hideoutgames.github.io/BabylonSlate/docs/)** (VitePress, deployed next to the editor preview). Markdown in `docs/` is the source for both GitHub and that site.

Local preview: `pnpm docs:dev`.

When adding a new `docs/**/*.md` file, add a sidebar entry in [`apps/docs/src/sidebar.ts`](../apps/docs/src/sidebar.ts) in the same change (see [`.cursor/rules/docs-site.mdc`](../.cursor/rules/docs-site.mdc)). `docs/README.md` and `docs/index.md` are exempt.

| Document | Purpose |
| --- | --- |
| [engineplan.md](engineplan.md) | Authoritative architecture, feature spec, roadmap, and delivery checklist |
| [CODING_STANDARDS.md](CODING_STANDARDS.md) | Coding conventions |
| [design/perf-budget.md](design/perf-budget.md) | A16 iPad performance budget and render rules |
| [design/gestures.md](design/gestures.md) | Touch and gesture design |
| [architecture/](architecture/) | Package and subsystem notes |
| [architecture/overview.md](architecture/overview.md) | Package and subsystem overview |
| [architecture/containers.md](architecture/containers.md) | `.babasset` / `.babproject` wire formats |
| [architecture/vfs.md](architecture/vfs.md) | Binary VFS, storage tiers, app settings |
| [architecture/command-layer.md](architecture/command-layer.md) | Undo, journal, dirty saves |
| [architecture/asset-registry.md](architecture/asset-registry.md) | Header-only guid index and importers |
| [architecture/global-search.md](architecture/global-search.md) | Project-wide text search |
| [architecture/object-model.md](architecture/object-model.md) | World, actors, tick |
| [architecture/bridge.md](architecture/bridge.md) | Bridge transports, snapshot layout, channels |
| [architecture/render.md](architecture/render.md) | Snapshot sync, visibility-gated editor loop, resource cache |
| [architecture/scripting.md](architecture/scripting.md) | Visual scripting compile and runtime |
| [architecture/scene-editing.md](architecture/scene-editing.md) | Viewport, outliner, gizmos |
| [architecture/input.md](architecture/input.md) | Action/axis mappings |
| [architecture/physics.md](architecture/physics.md) | Havok 3D and Rapier 2D |
| [architecture/debugger.md](architecture/debugger.md) | Command registry, console, stats HUD |
| [architecture/ui-runtime.md](architecture/ui-runtime.md) | UserInterface widget tree, layout, designer |
| [architecture/fonts.md](architecture/fonts.md) | Font payload, FontFace registry, fallback stacks |
| [architecture/sprites.md](architecture/sprites.md) | Sprite atlas, packer, SpriteComponent quad |
| [architecture/tilemaps.md](architecture/tilemaps.md) | Tileset / Tilemap assets, chunk VertexData |
| [architecture/anim-graph.md](architecture/anim-graph.md) | Worker animation graph evaluator |
| [architecture/shader-graph.md](architecture/shader-graph.md) | Shader IR to NodeMaterial |
| [architecture/theming.md](architecture/theming.md) | UI color palette and semantic tokens |
| [architecture/components.md](architecture/components.md) | Reusable Editor UI primitives and composites |
| [architecture/testing.md](architecture/testing.md) | Vitest projects, coverage gates, Playwright |
| [agents/issue-tracker.md](agents/issue-tracker.md) | Issue and spec workflow for agents |

When implementing a feature, start with **engineplan.md** for the spec, then the narrower docs above as they land.
