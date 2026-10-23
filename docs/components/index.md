# Components

A component gives an actor one ability: drawing a mesh, simulating a body, casting light, playing a sound. Select an actor and tap **Add Component** to attach one, then change its settings in the **Inspector**. Each page here lists the settings the Inspector shows. Most components work in world scenes, while the 2D Overlay components work only in Scene Layers; lights, cameras, water and other world-only components cannot be added to a layer. See [Actors](../scenes/actors.md) and [Scene Layers](../scenes/scene-layers.md).

## World

| Component | Description |
| --- | --- |
| [Save Game](save-game.md) | Chooses which parts of an actor a Save Game checkpoint stores and restores. |
| [Scene Streaming](scene-streaming.md) | Marks where another Scene loads into the running game. |
| [Landscape](landscape.md) | A sculptable terrain of height points you raise, lower, smooth, flatten and paint. |
| [Foliage](foliage.md) | Holds the trees, grass and rocks you paint onto surfaces. |
| [Spline](spline.md) | An editable 3D path with smooth curves and optional closed loops. |
| [Camera](camera.md) | The view the player sees in Play. |
| [Spring Arm](spring-arm.md) | Holds its child components at the end of an arm, with optional lag. |
| [Audio](audio.md) | Plays an Audio asset from an actor. |

## Rendering

| Component | Description |
| --- | --- |
| [Mesh](mesh.md) | Draws a built-in shape or a Model, with a Material, shadows and optional collision. |
| [Dynamic Runtime Mesh](dynamic-runtime-mesh.md) | A mesh whose triangles a script creates and changes while the game runs. |
| [Sprite](sprite.md) | Draws a 2D image from a Sprite asset. |
| [Tilemap](tilemap.md) | Draws a grid of tiles from a Tilemap asset, with optional collision. |
| [Render Target Capture](render-target-capture.md) | Renders the scene into a Render Target, for monitors, mirrors and minimaps. |
| [Mirror](mirror.md) | A flat surface that shows the scene reflected from the current camera. |
| [Light](light.md) | A point, spot or directional light. |
| [Rectangular Area Light](area-rect-light.md) | A rectangular light for windows, screens and light panels. |
| [Hemispheric Fill Light](hemispheric-fill-light.md) | Soft fill light with one colour from above and another from below. |
| [Fog Volume](fog-volume.md) | A local box or sphere of fog with soft edges. |
| [Outline](outline.md) | Draws a coloured silhouette around an actor. |
| [Deformer](deformer.md) | Bends and squashes a Mesh with a lattice of control points. |
| [Skybox](skybox.md) | A cubemap sky that surrounds the scene. |
| [3D Text](text-3d.md) | Flat, unlit text drawn in the world. |
| [Particle](particle.md) | Plays a Particle System from an actor. |

## Water

| Component | Description |
| --- | --- |
| [Global Water Volume](global-water-volume.md) | Water that reaches the horizon, with detail that follows the camera. |
| [Water Ocean](water-ocean.md) | A large rectangle of water with broad waves. |
| [Water Lake](water-lake.md) | A bounded oval of water with gentle waves. |
| [Water River](water-river.md) | Water that follows a path of points, with a current along the path. |
| [Water Puddle](water-puddle.md) | A shallow oval of water with small ripples. |
| [Water Removal Volume](water-removal-volume.md) | Removes water inside a box, sphere, cylinder or capsule. |
| [Water Buoyancy](water-buoyancy.md) | Makes an actor float on water, riding the waves and reacting to impacts. |

## Physics

| Component | Description |
| --- | --- |
| [Rigid Body](rigid-body.md) | Makes an actor move under physics: gravity, forces and collisions. |
| [Collider](collider.md) | Gives an actor a collision shape that blocks other colliders or acts as a trigger. |
| [Physics Constraint](physics-constraint.md) | Connects two bodies with a fixed, ball socket, hinge or distance joint. |
| [Movement](movement.md) | Walks and jumps an actor as a character that follows input, gravity and ground. |
| [Ragdoll](ragdoll.md) | Turns a Model's skeleton into physics bodies that collapse from its animation pose. |
| [Cable](cable.md) | A simulated rope or wire that hangs between two points, with optional collision. |
| [Blocking Volume](blocking-volume.md) | An invisible solid box that stops physics bodies. |

## AI and Animation

| Component | Description |
| --- | --- |
| [Animation Graph](animation-graph.md) | Plays an Animation Graph that drives Model animations and Sprite Animations. |
| [Behaviour Tree](behaviour-tree.md) | Runs a Behaviour Tree on an actor to drive its AI. |
| [Nav Agent](nav-agent.md) | Lets an actor find and follow paths across the baked NavMesh. |
| [NavMesh](nav-mesh.md) | Settings for baking the walkable surface that Nav Agents use. |
| [NavMesh Blocker](nav-mesh-blocker.md) | A box or cylinder that blocks navigation or makes it more costly. |

## 2D Overlay

These components work only in Scene Layers.

| Component | Description |
| --- | --- |
| [2D Anchor](2d-anchor.md) | Anchors a layer actor to a point on the layer and offsets it. |
| [2D Vertical Box](2d-vertical-box.md) | Stacks its children from top to bottom. |
| [2D Horizontal Box](2d-horizontal-box.md) | Lines up its children from left to right. |
| [2D Overlay Box](2d-overlay-box.md) | Layers its children in the same area. |
| [2D Scroll Box](2d-scroll-box.md) | Clips its content to a window and lets the player scroll it. |
| [2D Padding](2d-padding.md) | Insets the content of its parent without taking a layout slot. |
| [2D Spacer](2d-spacer.md) | Adds empty space inside a box, fixed or flexible. |
| [2D Safe Area](2d-safe-area.md) | Keeps its content clear of device cut-outs and rounded corners. |
| [2D Mask Panel](2d-mask-panel.md) | A box that clips everything inside it to its own rectangle. |
| [2D Mask](2d-mask.md) | Clips an actor and everything under it to a rectangle. |
| [2D Virtualized List](2d-virtualized-list.md) | A scrolling list that creates only the items in view. |
| [2D Virtualized Grid](2d-virtualized-grid.md) | A scrolling grid that creates only the items in view. |
| [2D Texture](2d-texture.md) | Draws a Texture as a flat image. |
| [2D Material](2d-material.md) | Draws a Material as a flat square. |
| [2D Panel](2d-panel.md) | A stretchable background that keeps its corners intact, from a Texture or a Material. |
| [2D Text](2d-text.md) | Draws text from a Font. |
| [2D Rich Text](2d-rich-text.md) | Draws text with inline formatting, images and animated letters. |
| [2D Painter](2d-painter.md) | A drawing surface for lines, shapes and paths that you draw from a script. |
| [2D Button](2d-button.md) | Makes an actor react to taps, clicks, hover and focus. |
| [2D Focus Target](2d-focus-target.md) | Lets keyboard and gamepad navigation reach any overlay element. |
| [2D Joystick](2d-joystick.md) | An on-screen touch joystick that feeds two axes into your Input Axis assets. |
| [2D Slider](2d-slider.md) | A draggable handle that picks a number between Min and Max. |
| [2D Range Slider](2d-range-slider.md) | A slider with two handles that picks a lower and an upper value. |
| [2D Checkbox](2d-checkbox.md) | A box the player taps to switch a checked state on or off. |
| [2D Radio Button](2d-radio-button.md) | A round button in a group where only one button can be checked. |
| [2D Toggle](2d-toggle.md) | A switch with a sliding knob that turns a setting on or off. |
| [2D Text Input](2d-text-input.md) | A single-line field the player types into. |
| [2D Numeric Input](2d-numeric-input.md) | An editable number with plus and minus buttons. |
| [2D Dropdown](2d-dropdown.md) | A button that opens a list of options. |
| [2D Progress Bar](2d-progress-bar.md) | A display-only bar that fills to show a value. |
