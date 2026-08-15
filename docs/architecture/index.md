# Architecture

Package and subsystem notes. Authoritative detail lives in the [engine plan](/engineplan).

| Document | Purpose |
| --- | --- |
| [Overview](overview.md) | Package map and data flow |
| [Containers](containers.md) | `.babasset` / `.babproject` wire formats |
| [VFS](vfs.md) | Binary VFS, storage tiers, app settings |
| [Command layer](command-layer.md) | Undo, journal, dirty saves |
| [Asset registry](asset-registry.md) | Header-only guid index and importers |
| [Plugins](plugins.md) | PluginSettings, content roots, `.babplugin`, Starter Content |
| [Global search](global-search.md) | Project-wide text search |
| [Object model](object-model.md) | World, actors, tick |
| [Bridge](bridge.md) | Transports, snapshot layout, channels |
| [Render](render.md) | Snapshot sync, visibility-gated loop, resource cache |
| [Scripting](scripting.md) | Visual scripting compile and runtime |
| [Scene editing](scene-editing.md) | Viewport, outliner, gizmos |
| [Input](input.md) | Action/axis mappings |
| [Physics](physics.md) | Havok 3D and Rapier 2D |
| [Debugger](debugger.md) | Command registry, console, stats HUD |
| [UI runtime](ui-runtime.md) | UserInterface widget tree, layout, designer |
| [Fonts](fonts.md) | Font payload, FontFace registry, fallback stacks |
| [Sprites](sprites.md) | Sprite atlas, packer, SpriteComponent quad |
| [Animation graph](anim-graph.md) | Worker animation graph evaluator |
| [Behaviour tree](behaviour-tree.md) | Tree IR, blackboard, explicit-stack evaluator |
| [Navigation](navigation.md) | Navmesh bake/query port, 2D remap, Scene chunk |
| [Shader graph](shader-graph.md) | Shader IR to NodeMaterial |
| [Theming](theming.md) | UI color palette and semantic tokens |
| [Components](components.md) | Reusable Editor UI primitives and composites |
| [Editor extensions](editor-extensions.md) | EditorUtilityObject / Interface, live Dockview GUI tabs |
| [Exporter](exporter.md) | Itch zip, `.babpack`, Preview Build, standalone player |
| [Testing](testing.md) | Vitest projects, coverage gates, Playwright |

`docs/` markdown is the source of truth for GitHub and the VitePress site.
