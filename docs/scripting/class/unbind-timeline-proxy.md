---
node: timelineProxy.unbind
---

# Unbind Timeline Proxy

Clears one proxy of a Timeline Clip asset instance, so its tracks stop applying.

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
- The object keeps the values the clip last wrote.
- [Unbind All Timeline Proxies](unbind-all-timeline-proxies.md) clears every proxy at once.
