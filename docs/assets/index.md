# Assets

Assets are the building blocks of a project: Scenes, Classes, Materials, sounds, models and more. You create most of them in the **Content Browser** with **New Asset**, which groups the types as listed below. Imported types come from files you bring in with **Import**. Double-tap an asset to open its editor.

## World

| Asset | Description |
| --- | --- |
| [Scene](scene.md) | A 3D or 2D world document. |
| [Scene Layer](scene-layer.md) | An unlit 2D overlay that draws on top of world Scenes. |
| [Prefab](prefab.md) | Placeable components without logic. Lighter than an Actor Class: no graph, events, variables or tick. |

## Input

| Asset | Description |
| --- | --- |
| [Input Action](input-action.md) | A button action, such as Jump, Interact or Fire. Add controls, then use its event in a graph. |
| [Input Axis](input-axis.md) | A number or 2D direction, such as Move, Look or Throttle. Combine keys, sticks and touch controls. |

## Data

| Asset | Description |
| --- | --- |
| [Data Definition](data-definition.md) | Define fields, defaults and validation for Data Tree entries. |
| [Data Tree](data-tree.md) | Organise typed entries in a hierarchy. Branches can use different Data Definitions. |

## Scripting

| Asset | Description |
| --- | --- |
| [Class](class.md) | A class with a parent and a logic graph. |
| [Enum](enum.md) | Named integer members used by pins and variables. |
| [Structure](structure.md) | A user-defined record of typed fields. |
| [Script Interface](script-interface.md) | A contract of methods that Classes can implement. |
| [Save Game](save-game.md) | Typed player progress with defaults, stable fields and reliable local save slots. |

## 2D

| Asset | Description |
| --- | --- |
| [Sprite](sprite.md) | A 2D image built from a Texture, with a pivot and optional collision. |
| [Tileset](tileset.md) | Tile definitions and collision for painting Tilemaps. |
| [Tilemap](tilemap.md) | A painted 2D tile map made of layers, using one or more Tilesets. |

## Animation

| Asset | Description |
| --- | --- |
| [Animation Graph](animation-graph.md) | A state machine that plays Animation or Sprite Animation clips. |
| [Sprite Animation](sprite-animation.md) | A 2D clip of Texture frames, played by an Animation Graph. |

## Rendering

| Asset | Description |
| --- | --- |
| [Material](material.md) | A shader graph that decides how a surface, particle, text or full-screen pass looks. |
| [Material Instance](material-instance.md) | Parameter values for a parent Material. Shares its compiled shader, so edits and variants cost no recompile. |
| [Material Function](material-function.md) | A reusable shader subgraph for Materials. |
| [Render Target](render-target.md) | A scene capture's render mode and output resolution. |
| [Render Target Texture](render-target-texture.md) | A live Render Target output that Materials can sample as a texture. |
| [Water](water.md) | Shared water appearance and waves for oceans, lakes, rivers and puddles. |
| [Basic Particle Emitter](particle-emitter.md) | A GPU emitter built from a stack of modules for spawn, shape, motion and colour. Its look comes from a particle Material. |
| [Particle Graph](particle-graph.md) | A node-graph emitter for custom particle behaviour, simulated on the CPU. Its look comes from a particle Material. |
| [Particle System](particle-system.md) | Plays up to 8 Basic Particle Emitters or Particle Graphs together on one actor. |
| [Skybox Creator](skybox-creator.md) | An editor tool that slices a Texture into six skybox faces. |

## Audio

| Asset | Description |
| --- | --- |
| [Audio Mixer](audio-mixer.md) | Global and per-channel default volumes for Play. |
| [Audio Channel](audio-channel.md) | A routing bus with an optional parent and reverb send. |
| [Sound Attenuation](sound-attenuation.md) | Distance falloff that opts Audio into 3D playback. |

## AI

| Asset | Description |
| --- | --- |
| [Behaviour Tree](behaviour-tree.md) | An AI tree of composites, tasks and decorators. |
| [Blackboard](blackboard.md) | Shared keys that a Behaviour Tree reads and writes. |

## Imported

These are created when you import files with **Import** in the **Content Browser**, not from **New Asset**.

| Asset | Description |
| --- | --- |
| [Font](font.md) | A typeface imported from a TTF, OTF, WOFF or WOFF2 file, or from an MSDF atlas. |
| [Audio](audio.md) | A sound imported from an MP3, WAV or OGG file. |
| [Model](model.md) | A 3D mesh imported from a GLB, glTF, FBX, OBJ or STL file. |
| [Skeleton](skeleton.md) | The bones of an imported model. |
| [Animation](animation.md) | One animation clip from an imported model. |
| [Texture](texture.md) | An image imported from a PNG, JPEG, WebP or GIF file, or an environment map. |

## Plugins

| Asset | Description |
| --- | --- |
| [Plugin Settings](plugin-settings.md) | The settings document of a plugin: how it is listed, what it depends on and which editor classes it runs. |
