---
node: timelineProxy.unbindAll
---

# Unbind All Timeline Proxies

Clears every proxy of a Timeline Clip asset instance, so none of its tracks apply.

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

- The objects keep the values the clip last wrote. Bind them again with [Bind Actor to Timeline Proxy](bind-actor-to-timeline-proxy.md) and [Bind Component to Timeline Proxy](bind-component-to-timeline-proxy.md).
