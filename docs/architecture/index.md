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
| [Console commands](console-commands.md) | Builtin catalog, apply-vs-log audit, engine pass slices |
| [UI runtime](ui-runtime.md) | UserInterface widget tree, layout, designer |
| [Fonts](fonts.md) | Font payload, FontFace registry, fallback stacks |
| [Sprites](sprites.md) | Sprite atlas, packer, SpriteComponent quad |
| [Animation graph](anim-graph.md) | Worker Animation Graph evaluator, Animation Object, transition rules |
| [Behaviour tree](behaviour-tree.md) | Tree IR, blackboard, explicit-stack evaluator |
| [Navigation](navigation.md) | Navmesh bake/query port, 2D remap, Scene chunk |
| [Audio](audio.md) | Mixer/channel/attenuation, AudioService, spatial, reverb bake |
| [Particles](particles.md) | Particle Emitter / System, GPUParticleSystem wrap, particle-domain materials |
| [Shader graph](shader-graph.md) | Shader IR to NodeMaterial |
| [Theming](theming.md) | UI color palette and semantic tokens |
| [Components](components.md) | Reusable Editor UI primitives and composites |
| [Editor extensions](editor-extensions.md) | EditorUtilityObject / Interface, live Dockview GUI tabs |
| [Exporter](exporter.md) | Itch zip, `.babpack`, Preview Build, standalone player |
| [Source control](source-control.md) | Git LFS locking, SecretStore, advisory UX, mtime rescan |
| [Testing](testing.md) | Vitest projects, coverage gates, Playwright |

`docs/` markdown is the source of truth for GitHub and the VitePress site.
