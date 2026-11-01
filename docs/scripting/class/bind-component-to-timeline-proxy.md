---
node: timelineProxy.bindComponent
---

# Bind Component to Timeline Proxy

Binds a Component proxy of a Timeline Clip asset instance to a component, so the proxy's tracks animate it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The instance, from [Create Timeline Clip](create-timeline-clip.md). |
| Component | ActorComponent Reference | The component to animate, of the proxy's Class. It must be connected. |
| Absolute Transform | Boolean | Off: transform keys offset the component from its transform now. On: they set its transform relative to its parent. Off by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Add Node lists one for each Component proxy of a clip asset, titled with its name, such as **Bind Handle Glow Proxy**. Pick another of the clip's Component proxies under **Proxy** in the **Inspector**; the Component input takes its Class.
- A proxy holds one object: binding replaces the one bound before, from the next frame.
- If the proxy is removed from the clip, or becomes an Actor proxy, the node shows an error until you pick another.
- See [Play a clip asset](../../assets/timeline-clip.md#play-a-clip-asset).
