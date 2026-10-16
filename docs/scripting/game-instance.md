# Game Instance and Subsystems

The Game Instance is one object that lives for the whole play session, across scene changes. Subsystems are objects the engine creates for you, once per session or once per scene.

## Set up a Game Instance

1. Create a Class with **GameInstance** as its parent. See [Classes](classes.md). Its graph starts with [Event On Init](class/event-on-init.md) and [Event Tick](class/event-tick.md).
2. In **Project Settings > Game**, set **Game Instance** to your class.

Use it for state that must outlive a scene, such as the score or the chosen character, and to [load saves](save-games.md).

## Game Instance events

| Event | When it runs |
| --- | --- |
| [Event On Init](class/event-on-init.md) | Once, when the session starts, before the first scene loads. |
| [Event On Scene Start Loading](class/event-on-scene-start-loading.md) | Each time a scene starts loading. Gives the **Scene Name**. |
| [Event On Scene Finish Loading](class/event-on-scene-finish-loading.md) | When that scene has finished loading. |
| [Event On First Scene Loaded](class/event-on-first-scene-loaded.md) | Once per session, when the first scene has finished loading. |
| [Event On Scene Exit](class/event-on-scene-exit.md) | When the current scene is left, after its actors are removed. |
| [Event Tick](class/event-tick.md) | Every simulation step, before the actors tick. |
| [Event On End](class/event-on-end.md) | Once, when Play stops or the game quits. Changing scenes never runs it. |

**On Game Loaded** and **Scalability Changed** are also available; see [Events](events.md).

In Game Instance graphs, [Get Scene Loading Progress](class/get-scene-loading-progress.md) drives a loading screen and [Get Scene Reference](class/get-scene-reference.md) returns the current scene.

## Reach the Game Instance

From any other graph, use [Get Game Instance](class/get-game-instance.md), then [Cast To](class/cast-to.md) your class to read its variables and call its functions.

## Subsystems

| Parent Class | Lives for | Good for |
| --- | --- | --- |
| **GameSubsystem** | The whole session, like the Game Instance. | Services the whole game uses, such as quests or achievements. |
| **SceneSubsystem** | One main scene. Each scene load gets a new one. | Managers for one level, such as counting the enemies left. |

- There is nothing to register: Play, Preview Build and exported games create every subsystem class automatically.
- Only classes without subclasses are created. A subsystem class that another subsystem class inherits from serves as a base only.
- New subsystem classes start with **Event On Init** only. Add other events from the **Events** **+** menu.
- Streamed scenes and Scene Layers do not get Scene Subsystems.

To use a subsystem from another graph, choose **Get** followed by its class name in **Add Node**, under **Game Subsystems** or **Scene Subsystems**. See [Get Subsystem](class/get-subsystem.md). It returns nothing while that subsystem is not alive, so check it with [Is Valid](class/is-valid.md). If several classes inherit from the class you ask for, **Compiler Results** reports an error.

## Subsystem events

Game Subsystems have the same events as the Game Instance. Their **On Init** runs before the Game Instance's, and their **On End** runs after it, in reverse order.

Scene Subsystems have **On Init**, **Tick**, **On End** and **On Game Loaded**, plus:

| Event | When it runs |
| --- | --- |
| [Event On Scene Loaded](class/event-on-scene-loaded.md) | The scene has loaded and its actors have begun play. |
| [Event On Streamed Scene Loaded](class/event-on-streamed-scene-loaded.md), [Unloaded](class/event-on-streamed-scene-unloaded.md) | A streamed scene becomes ready or is removed. |
| [Event On Scene Layer Added](class/event-on-scene-layer-added.md), [Removed](class/event-on-scene-layer-removed.md) | A Scene Layer is created or removed. |
| [Event On Scene Actor Spawned](class/event-on-scene-actor-spawned.md), [Destroyed](class/event-on-scene-actor-destroyed.md) | An actor in the world enters play or is destroyed. |

A Scene Subsystem's **On Init** runs before any actor in its scene begins play, and its **On End** runs when the scene is left or Play stops.

## Notes

- The Game Instance and subsystems cannot be spawned or placed in a scene.
- [Get Game Instance](class/get-game-instance.md) and the subsystem Get nodes are not available in editor tools.
