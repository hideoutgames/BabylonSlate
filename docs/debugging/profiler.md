# Profiler

Record frame and tick timings, capture the render stages of one frame, and record a trace of the game to replay tick by tick.

## Open the Profiler

1. Turn on **Debug > Overlays > Profiler** before you play.
2. Press **Play**, or run a [Preview Build](../publishing/preview-build.md).
3. Tap **Profiler** in the toolbar over the game.

The **Profiler and Frame Debugger** window opens over the game. Opening it does not record anything. The game keeps running underneath, and the toolbar over it stays usable. Tap the game to play it again: it gets the keyboard back and the window stays open. Close the window with **Close** or <kbd>Esc</kbd>.

## Record performance

1. Tap **Record Performance**.
2. Play the part of the game you want to measure.
3. Tap **Stop Recording**, or wait: recording stops on its own after the **Recording Duration**, when its data budget is full, or when the session ends.

A recording keeps running when you close the window. While it runs, the toolbar over the game shows **Recording**; its **Stop Recording** button stops it and opens the window at its **Summary**.

You can also record by typing `profile start` and `profile stop` in the [console](console.md) window; `capture frame` captures a frame. **Execute Console Command** cannot run these.

Choose a view:

| View | Shows |
| --- | --- |
| Summary | **Frame Pacing**: median frame time, FPS and how many frames were slow. **Worker Tick**: median script and physics time, and how many ticks went over 8 ms. The table also lists each phase of the tick: **Game Instance**, **Scene Subsystems**, **Actors**, **Components**, **Physics**, **Post-Physics** and **Scene Systems** (Delays, Behaviour Trees, Animation Graphs and crowds). |
| Timeline | A chart of every frame, tick and GPU query and the game's memory on one time axis, with a **Markers** row for loading screens, scene changes and long tasks, then the samples as a table. |
| Frame Report | The result of **Capture Frame**. |

Only one recording or frame capture runs at a time. The window keeps your last five recordings and last five frame captures until you close the editor, so capturing a frame does not replace a recording. Very large recordings are kept fewer at a time. When it holds more than one, a second row picks which **Recording** or **Frame Capture** to show.

To compare two recordings, show the newer one in **Summary** and pick the older one in **Compare With**. Each row then shows the older value, the newer value and the change; a slower value is marked in red. The comparison stays while you record again, so you can record, change something, record, and compare. A saved recording you open joins the list under its file name, so you can compare with a baseline you exported earlier. **Copy** puts the result of the current view on the clipboard as JSON, **Export** downloads it as a file, and **Open Saved Result** loads an exported recording or frame report. A recording saved before tick phases were recorded opens with script and physics only, and one saved before memory and long tasks were recorded opens without them.

In **Timeline**:

- The chart has a row for **Frames**, one for **Ticks**, one for **GPU** when GPU timing was on, and one for **Memory**, each with its own scale. **Memory** is the textures and geometry the engine has loaded, in MiB, sampled five times a second. Each tick sits under the frame that showed it. **Ticks** stack each tick's phases. A dashed line marks the budget: one frame at your frame cap, or 8 ms per tick.
- **Markers** shows loading screens, scene changes and **Long Tasks**: stretches of 50 ms or more when the browser's main thread was busy, which can stall input and frames. Safari does not report long tasks.
- **Metric** picks what **Frames** shows: **Frame Time**, **Preparation**, **Submission** or **Draw Calls**. **Script** or **Physics** shows that part of each tick instead of its phases.
- Hover a bar to read its sample. Tap or click it to select it: the table switches to its frames or ticks, and the details show the sample with the tick its frame presents, or the first frame that presented the tick. The arrow keys move to the previous or next sample.
- Drag across the chart to select a time range. A summary then shows each row's count, median, p95 and maximum in that range, and how many samples went over budget. **Clear Range** or <kbd>Esc</kbd> removes it.
- **Completed Frames**, **Runtime Ticks**, **GPU Queries** and **Memory Samples** choose the table. **Memory Samples** lists texture and geometry bytes apart. **Previous Over Budget** and **Next Over Budget** jump between slow samples, and the **Sample** field selects one by number. On a narrow screen the sample's details sit under the table.

## Capture a frame

Tap **Capture Frame**, in the window or in the toolbar over the game. Haptic waits for the next complete frame and lists every render stage in the order it ran, with its timing, draw calls and render targets. A paused game can be captured too.

Stage timings include nested passes and waits for the graphics driver. They are not GPU timings for each pass.

## Profiler settings

**Engine Settings > Debugger > Profiler**:

| Setting | Description |
| --- | --- |
| Recording Duration (Seconds) | How long a recording runs, from 1 to 60. Default 10. |
| GPU Timing | Also measures GPU frame time where the browser supports it. Off by default. Not available with WebGPU. |
| Profile Retained Data Budget (MiB) | Under **Advanced**. The most timing data a recording keeps, from 4 to 64. Default 16. |

Changes apply to the next recording.

## Trace recording

A trace records the whole game state on every tick, with its logs, prints and input, so you can step through what happened.

1. During Play, open the [console](console.md) and type `snapshot start`.
2. Play through the problem.
3. Type `snapshot stop`, or stop Play.

When Play ends, the trace opens as a read-only document with three windows:

- **Timeline** charts script and physics time per tick against the 8 ms tick budget, on the same chart as the Profiler's [Timeline](#record-performance). Each bar is the slowest tick of the frames it covers; hover one to read it, and tap it to select its frame. The **Markers** row shows the frames that recorded logs, prints or input. The selected frame's summary adds its publish time. Scrub or step to any frame, zoom in around it, or jump between ticks that went over budget.
- **Snapshot** shows the game instance, subsystems, actors, components and their variables at the selected frame. **Changes** lists what was added, removed or changed since the previous frame.
- **Log** shows the logs and prints of the selected frame and up to 29 frames before it.

To open a trace again later, choose **Debug > Recent Traces**. It lists the project's ten newest traces by when they were recorded.

**Engine Settings > Debugger > Trace > Trace Memory Budget (MiB)** limits a trace, from 1 to 256. Default 128. When the trace is full, the oldest frames are discarded and recording continues. A single frame larger than the whole budget stops recording; the frames before it are kept.

## Related

- [Debugging](index.md)
- [Console](console.md)
