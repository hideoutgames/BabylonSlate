# Architecture

Package and subsystem notes. Authoritative detail lives in the [engine plan](/engineplan).

| Document | Purpose |
| --- | --- |
| [Overview](overview.md) | Package map and data flow |
| [Containers](containers.md) | `.babasset` / project folder / `.babplugin` wire formats |
| [VFS](vfs.md) | Binary VFS, storage tiers, app settings |
| [Command layer](command-layer.md) | Undo, journal, dirty saves |
| [Asset registry](asset-registry.md) | Header-only guid index and importers |
| [Plugins](plugins.md) | PluginSettings, content roots, `.babplugin`, Starter Content |
| [Global search](global-search.md) | Project-wide text search |
| [Keybinds](keybinds.md) | Desktop shortcuts, keycaps, overrides |
| [Object model](object-model.md) | World, actors, tick |
| [Bridge](bridge.md) | Transports, snapshot layout, channels |
| [Render](render.md) | Snapshot sync, visibility-gated loop, resource cache |
| [Scripting](scripting.md) | Visual scripting compile and runtime |
| [Save Games](../save-games.md) | Typed gameplay saves, recovery, preview tools, and platform coverage |
| [Scene editing](scene-editing.md) | Viewport, outliner, gizmos |
| [Scene layers](scene-layers.md) | SceneLayer 2D overlay compositor |
| [Input](input.md) | Action/axis mappings |
| [Physics](physics.md) | Havok 3D and Rapier 2D |
| [Debugger](debugger.md) | Command registry, console, stats HUD |
| [Console commands](console-commands.md) | Builtin catalog, apply audit, autocomplete |
| [Fonts](fonts.md) | Font payload, FontFace registry, fallback stacks |
| [Sprites](sprites.md) | Sprite atlas frames, Sprite Animation, SpriteComponent quad |
| [Tilemaps](tilemaps.md) | Tileset / Tilemap assets, chunk VertexData, painting, Rapier chains |
| [Animation graph](anim-graph.md) | Worker Animation Graph evaluator, Animation Object, transition rules |
| [Behaviour tree](behaviour-tree.md) | Tree IR, blackboard, explicit-stack evaluator |
| [Navigation](navigation.md) | Navmesh bake/query port, 2D remap, Scene chunk |
| [Audio](audio.md) | Mixer/channel/attenuation, AudioService, spatial, reverb bake |
| [Particles](particles.md) | Basic / Particle Graph emitters, Particle System, Material-only look |
| [Materials](shader-graph.md) | Material and Material Function graphs, compiler, preview, runtime |
| [Theming](theming.md) | UI color palette and semantic tokens |
| [Components](components.md) | Reusable Editor UI primitives and composites |
| [Editor extensions](editor-extensions.md) | Engine and Project Extensions, EditorUtilityObject graphs, Skybox Creator |
| [Exporter](exporter.md) | Itch zip, `.babpack`, Preview Build, standalone player |
| [Source control](source-control.md) | Git LFS locking, SecretStore, advisory UX, mtime rescan |
| [Testing](testing.md) | Vitest projects, coverage gates, Playwright |
| [CI performance](../ci-performance.md) | CI baseline, independent browser build pilot and rollback |

`docs/` markdown is the source of truth for GitHub and the VitePress site.
