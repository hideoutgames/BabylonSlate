---
node: timelineProxy.get
---

# Get Timeline Proxy

Returns the objects bound to a proxy of a Timeline Clip asset instance.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Timeline Clip Reference | The instance, from [Create Timeline Clip](create-timeline-clip.md). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Objects | Array of Actor Reference | Every object bound to the proxy, in the order they were bound, typed to the proxy's Class: actors for an Actor proxy, components for a Component proxy. Empty while the proxy is unbound. |

## Notes

- Add Node lists one for each proxy of a clip asset, such as **Get Door Proxy**. Pick another under **Proxy** in the **Inspector**.
- A bound object that was destroyed is left out.
- Use [For Each](for-each.md) to act on each bound object, or [Array Length](array-length.md) to count them.
