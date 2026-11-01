---
node: timelineProxy.bindActor
---

# Bind Actor to Timeline Proxy

Binds an Actor proxy of a Timeline Clip asset instance to an actor, so the proxy's tracks animate it.

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
- A proxy holds one object: binding replaces the one bound before. A playing instance applies the new binding from the next frame, and Relative keys offset the new actor from where it stood when it was bound.
- If the proxy is removed from the clip, or becomes a Component proxy, the node shows an error until you pick another.
- See [Play a clip asset](../../assets/timeline-clip.md#play-a-clip-asset).
