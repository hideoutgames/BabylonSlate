---
node: timelineProxy.get
---

# Get Timeline Proxy

Returns the object a proxy of a Timeline Clip asset instance is bound to.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Timeline Clip Reference | The instance, from [Create Timeline Clip](create-timeline-clip.md). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Object | Actor Reference | Typed to the proxy's Class: an actor for an Actor proxy, a component for a Component proxy. None while the proxy is unbound. |

## Notes

- Add Node lists one for each proxy of a clip asset, such as **Get Door Proxy**. Pick another under **Proxy** in the **Inspector**.
- A bound object that was destroyed reads as None.
