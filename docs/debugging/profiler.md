# Profiler

Record frame and tick timings, capture the render stages of one frame, and record a trace of the game to replay tick by tick.

## Open the Profiler

1. Turn on **Debug > Overlays > Profiler** before you play.
2. Press **Play**, or run a [Preview Build](../publishing/preview-build.md).
3. Tap **Profiler** in the toolbar over the game.

The **Profiler and Frame Debugger** window opens. Opening it does not record anything.

## Record performance

1. Tap **Record Performance**.
2. Play the part of the game you want to measure.
3. Tap **Stop Recording**, or wait: recording stops on its own after the **Recording Duration**, when its data budget is full, or when the session ends.

Choose a view:

| View | Shows |
| --- | --- |
| Summary | **Frame Pacing**: median frame time, FPS and how many frames were slow. **Worker Tick**: median script and physics time, and how many ticks went over 8 ms. |
| Timeline | Every sample as a table. Switch between **Completed Frames**, **Runtime Ticks** and, when available, **GPU Queries**. **Previous Over Budget** and **Next Over Budget** jump between slow samples. |
| Frame Report | The result of **Capture Frame**. |

Only one recording or frame capture runs at a time. The window keeps the latest recording and the latest frame capture, so capturing a frame does not replace a recording. **Copy** puts the result of the current view on the clipboard as JSON, **Export** downloads it as a file, and **Open Saved Result** loads an exported recording or frame report.

In **Timeline**, select any sample in the chart, the table or the **Sample** field; the table scrolls to it. On a narrow screen the sample's details sit under the table.

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

- **Timeline** graphs script and physics time per tick. Scrub or step to any frame, or jump between frames that went over budget.
- **Snapshot** shows the game instance, subsystems, actors, components and their variables at the selected frame. **Changes** lists what was added, removed or changed since the previous frame.
- **Log** shows the logs and prints of the selected frame and up to 29 frames before it.

**Engine Settings > Debugger > Trace > Trace Memory Budget (MiB)** limits a trace, from 1 to 256. Default 128. When the trace is full, the oldest frames are discarded and recording continues. A single frame larger than the whole budget stops recording; the frames before it are kept.

## Related

- [Debugging](index.md)
- [Console](console.md)
