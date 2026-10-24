# Console

The console runs commands that change quality, control time, show debug views and inspect the running game.

## Open the console

- **Play:** turn on **Debug > Overlays > Console** before you play, then tap **Console** in the Play toolbar.
- **Preview Build:** with the same Debug menu item on, tap **Console** over the game.
- **Any graph:** [Execute Console Command](../scripting/class/execute-console-command.md) runs a command line and returns its **Success** and **Output**.

Exported games have no console window. They still run commands from **Execute Console Command**.

The game keeps running while the console is open, and pressing the game does not close it: use <kbd>Esc</kbd> or **Close**. The command field is ready to type in when the console opens. On touch devices it opens without the on-screen keyboard; tap the field to type. As you type, a list suggests commands, arguments and values: use the arrow keys to choose, <kbd>Tab</kbd> or a tap to complete, and <kbd>Enter</kbd> to run. With no suggestions showing, the arrow keys step through earlier commands. **Clear** empties the transcript and **Copy Transcript** copies it.

## Command syntax

- Arguments follow the command, separated by spaces: `slomo 0.5`. Put text with spaces in quotes.
- You can also name arguments: `slomo rate=0.5`.
- On/off commands accept `on` or `off` (also `true`, `false`, `1`, `0`, `yes`, `no`). With no argument they mean `on`.
- Commands that set a value print the current value when you leave the value out: `volume` prints the master volume.
- Quality, render path, frame cap and volume changes last for the session. The next Play starts from your project settings.

## Commands

**Debug only** commands work in Play, in Preview Build and in exports with **Bundle Debugger** on. Other exports reply that the command is not available in this build. All other commands work everywhere.

| Command | Arguments | Description | Debug only |
| --- | --- | --- | --- |
| `changescene` | scene | Loads a scene by its asset GUID or name. |  |
| `quality` | `low`, `medium`, `high`, `ultra` or `reset` | Sets every rendering quality group, or resets them. No argument prints the current values. |  |
| `quality shadows` | tier or `reset`; `budget` N or `auto`; `distance` N; `enabled` `on`/`off` | Shadow quality, the number of shadowed lights, shadow distance (1 to 1,000,000) and shadows on or off. |  |
| `quality resolution` | tier or `reset`; `scale` 0.25 to 1 | Render resolution quality, or a fixed fraction of the output size. |  |
| `quality textures` | tier or `reset` | Texture quality. |  |
| `quality geometry` | tier or `reset`; `lod` `on`/`off`; `distance` 0.25 to 4 | Geometry quality, automatic Model LOD and its switch distance scale. |  |
| `quality water` | tier or `reset`; setting and value | Water rendering quality, or one water setting (see below). Buoyancy is unaffected. |  |
| `quality postprocessing` | tier or `reset` | Post-processing quality. |  |
| `quality lighting` | tier or `reset`; `budget` N or `auto` | Lighting quality and the number of local lights. |  |
| `renderpath` | `auto`, `forward`, `clusteredForward` or `reset` | Requests a render path for the session. No argument prints the requested and actual path and the GPU backend. |  |
| `fixedlights` | `on`, `off`, `multiply`, `branch` or `reset` | Turns fixed-shape lighting on or off for the session. With it on, built-in materials compile their shaders once for the scene's lights, so a light turning on or off or changing places does not recompile them. When they do recompile (for example for more lights than they were built for), the view keeps its last image until the new shaders are ready instead of drawing the old ones. `multiply` and `branch` turn it on and choose how shaders skip unused light slots (`multiply` is the default). No argument prints the current state; Play restores the editor's state when it stops. |  |
| `framecap` | fps | Limits the frame rate. 0 or less uses 60. |  |
| `volume` | 0 to 1 | Sets the master volume, like [Set Global Volume](../scripting/class/set-global-volume.md). |  |
| `quit` |  | Stops the session. Play and Preview Build close and return to the editor; an exported game stops running. |  |
| `help` | command name | Lists every command, or shows one command's arguments. |  |
| `pause` |  | Pauses the game. | Yes |
| `resume` |  | Resumes the game. | Yes |
| `unpause` |  | Same as `resume`. | Yes |
| `step` |  | Advances one tick and stays paused. | Yes |
| `slomo` | rate, 0 to 8 | Slows or speeds up game time. 1 is normal speed; 0 freezes time. | Yes |
| `freecam` | `on`/`off` | Flies a separate camera while the game keeps running. Pointer, touch and WASD move the camera, and an on-screen fly stick appears; a gamepad still controls the game. `off`, `possess` or `changescene` return to the game camera. | Yes |
| `possess` | actor name or GUID | Views the game through that actor's camera. | Yes |
| `showfps` | `on`/`off` | Shows or hides Stats. | Yes |
| `stat unit` | `on`/`off` | Adds the tick total, the time of each tick phase, the publish time and a history graph to Stats. | Yes |
| `stat memory` | `on`/`off` | Adds memory use to Stats. | Yes |
| `stat draws` | `on`/`off` | Adds draw calls, meshes, textures and render timings to Stats. | Yes |
| `stat threads` | `on`/`off` | Adds message traffic, actor count and tick count to Stats. | Yes |
| `lightsdebug` | `on`/`off` | Shows which lights illuminate and which cast shadows. | Yes |
| `wireframe` | `on`/`off` | Draws meshes as wireframes. | Yes |
| `showbounds` | `on`/`off` | Draws the bounding box of each mesh. | Yes |
| `actorboundingbox` | `on`/`off` | Same as `showbounds`. | Yes |
| `showcollision` | `on`/`off` | Draws the physics collision shapes. | Yes |
| `debugphysics` | `on`/`off` | Same as `showcollision`. | Yes |
| `shownav` | `on`/`off` | Shows the NavMesh and NavMesh Blockers. | Yes |
| `shownavdebug` | `on`/`off` | Same as `shownav`. | Yes |
| `showpathfinding` | `on`/`off` | Shows each agent's current path, corners and destination. | Yes |
| `shownavagent` | `on`/`off` | Shows agent bounds, paths, names and movement state. | Yes |
| `behaviourtreedebug` | `on`/`off` | Opens the Behaviour Tree Debugger with live node states and Blackboards. | Yes |
| `showaudiodebug` | `on`/`off` | Lists the sounds playing, with their volume, pitch and distance. | Yes |
| `dumpactors` |  | Prints every actor with its name, class, GUID and position, rounded to four decimals. | Yes |
| `inspect` | actor name or GUID | Prints an actor's position and variables. With no argument it uses the actor selected in the Play Inspector. | Yes |
| `destroyactor` | actor name or GUID | Destroys an actor for this session. | Yes |
| `dumplog` |  | Prints the session log. | Yes |
| `snapshot start` |  | Starts a trace recording. See [Profiler](profiler.md#trace-recording). | Yes |
| `snapshot stop` |  | Stops the trace recording. | Yes |
| `profile start` |  | Starts a performance recording, like **Record Performance** in the [Profiler](profiler.md#record-performance). Console window only. |  |
| `profile stop` |  | Stops the performance recording and opens its **Summary**. Console window only. |  |
| `capture frame` |  | Captures the render stages of the next frame, like **Capture Frame**. Console window only. |  |

**Console window only** commands work when you type them in the console window during Play or Preview Build. The editor runs them, so **Execute Console Command** and exported games do not have them.

Actor names must match exactly and belong to one actor; use the GUID when names repeat.

**Water settings** for `quality water`: `shadingDetail` (`low` to `ultra`), `meshDensity` (0.5 to 1.5), `contactResolution` (256 to 1024), `refraction` (`on`/`off`), `refractionScale` (0.25 to 1), `reflections` (`sky`, `screenSpace` or `planar`), `reflectionSteps` (4 to 32), `planarScale` (0.25 to 1), `fftSize` (64, 128 or 256) and `fftCascades` (1 to 3). For example: `quality water reflections planar`.

## Your own commands

Create a Class whose parent is **DebugCommand** and add [Event On Command Run](../scripting/class/event-on-command-run.md). Set its **Command Name**, **Description**, **Category** and **Parameters** in the **Inspector**; each parameter becomes an output pin.

- Your commands work in every build, including release exports, and appear in suggestions and `help`.
- The names of built-in commands are reserved.
- Use them for game-specific cheats, such as god mode or giving items.

## Related

- [Debugging](index.md)
- [Graphics](../graphics/index.md)
