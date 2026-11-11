---
node: timelineProxy.bindActor
---

# Bind Actor To Timeline Proxy

Adds an actor to an Actor proxy of a Timeline Clip asset instance, so the proxy's tracks animate it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The instance, from [Create Timeline Clip](create-timeline-clip.md). |
| Actor | Actor Reference | The actor to animate, of the proxy's Class. It must be connected. |
| Absolute Transform | Boolean | Off: transform keys offset the actor from where it stands now. On: they set its world transform. Off by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Add Node lists one for each Actor proxy of a clip asset, titled with its name, such as **Bind Door Proxy**. Pick another of the clip's Actor proxies under **Proxy** in the **Inspector**; the Actor input takes its Class.
- A proxy holds any number of actors: each Bind adds one, and every bound actor plays the proxy's tracks. Relative keys offset each actor from where it stood when it was bound. A playing instance applies a new binding from the next frame.
- Binding an actor that is already bound to the proxy keeps it once, with the new **Absolute Transform** and, for Relative keys, where it stands now.
- [Unbind Timeline Proxy](unbind-timeline-proxy.md) clears every actor bound to the proxy, and [Get Timeline Proxy](get-timeline-proxy.md) returns them.
- If the proxy is removed from the clip, or becomes a Component proxy, the node shows an error until you pick another.
- See [Play a clip asset](../../assets/timeline-clip.md#play-a-clip-asset).
