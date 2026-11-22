---
node: flow.event.tick
---

# Event Tick

Runs on every simulation step, or every **Tick Interval**, giving the time since the previous tick.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Delta Seconds | Float | Simulation time since the previous tick, in seconds, scaled by time dilation. |

## Notes

- Set **Event Tick** to Disabled in **Actor Defaults** to stop it for an actor; components keep ticking.
- While the game is paused by [**Set Game Paused**](set-game-paused.md), it runs only for actors and Game Instances with **Tick On Pause**, and for actors in a Scene Layer with **Tick On Pause**.
- Every tick runs the graph, even while an earlier tick's run still waits on a latent node such as [**Delay**](delay.md). Each run waits on its own, so a Delay here continues once for every tick that reached it.
- Also available in Game Instance and subsystem classes, and in Object classes that implement the **Tickable Object** interface; see [Objects and lifetime](../object-lifetime.md#tick).

## Tick Interval

Set **Tick Interval** in a class's **Actor Defaults** to run its actors' **Event Tick** less often, for actors that do not need to react on every step. A child class inherits it until it sets its own.

- The interval is in seconds; 0, the default, ticks every step. It rounds to a whole number of simulation steps, and an interval shorter than one step ticks every step.
- **Delta Seconds** grows to the simulation time since the actor's previous **Event Tick**, and [**Get Delta Seconds**](get-delta-seconds.md) returns the same value while the tick runs. Scale movement and timers by it as usual.
- Actors of one class take turns: their ticks spread over the steps of the interval instead of all landing on the same one. An actor's first tick comes within one interval of its spawn.
- Time dilation stretches the interval, as it stretches every step. While the game is paused, an actor without **Tick On Pause** counts no time.
- Input events still run on every step, so the actor sees every press and release.
- Components, physics, movement and animation keep updating every step.
- Nodes that act for one step, such as [**Add Force**](add-force.md), **Add Torque** and **Add Movement Input**, act only on the steps that tick. **Add Force** applies the push for the whole interval at once, and **Add Movement Input** moves the actor on one step out of every interval. Keep smoothing, forces and movement on actors that tick every step.
