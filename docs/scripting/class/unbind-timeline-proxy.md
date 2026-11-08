---
node: timelineProxy.unbind
---

# Unbind Timeline Proxy

Clears every object bound to one proxy of a Timeline Clip asset instance, so its tracks stop applying.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The instance, from [Create Timeline Clip](create-timeline-clip.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Add Node lists one for each proxy of a clip asset, such as **Unbind Door Proxy**. Pick another under **Proxy** in the **Inspector**.
- A proxy can hold several objects, one per Bind; Unbind clears them all. For example, **Unbind Mannequin Proxy** clears every Mannequin bound with **Bind Mannequin Proxy**.
- The objects keep the values the clip last wrote.
- [Unbind All Timeline Proxies](unbind-all-timeline-proxies.md) clears every proxy at once.
