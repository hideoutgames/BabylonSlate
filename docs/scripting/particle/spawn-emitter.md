---
node: trigger.spawn
---

# Spawn Emitter

Plays another emitter at a particle's position when Condition is not 0, for example a spark burst where each particle dies.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Condition | Float | 0 | Not 0 fires. Checked for every particle each frame. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Settings

| Setting | Description |
| --- | --- |
| Emitter | The Particle Emitter or Particle Graph to play. |
| Limit | How many emitters this node may have playing at once. Spawns beyond it are skipped. |
| Min Interval | Seconds between two spawns of this node. |
| Inherit Velocity | The spawned emitter keeps moving at the particle's velocity when it fired. |

## Notes

- **On Death** and **On Spawn** in the Inspector wire Condition for the two common cases. On Death fires once for each particle as it dies (Normalized Age reaches 1). On Spawn fires once for each particle in its first frame (Age is at most Delta Time).
- A wired value that stays not 0 fires every frame, so Limit and Min Interval decide how often it plays.
- The spawned emitter plays once, for its **Duration**, then its particles fade out. It keeps playing after the particle that started it has died, and stops when the effect is removed.
- A spawned Particle Graph can spawn emitters too, up to two levels below the effect. Deeper spawns do not play, and a Particle Graph that spawns itself is an error.
- Spawned emitters follow pause and time dilation.
