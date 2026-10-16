---
node: scalability.getEffective
---

# Get Effective Scalability

Returns the quality settings you requested and the ones the renderer is using.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Settings | ScalabilitySnapshot | The requested and effective settings, plus the result of the latest request. |
| Ready | Boolean | True once the renderer has confirmed settings at least once. |
| Requested Gpu Backend | GpuBackend | The GPU backend that was asked for: Auto, WebGL2 or WebGPU. |
| Effective Gpu Backend | GpuBackend | The GPU backend in use. |
| Fallback Reason | String | Explains why the requested render path or backend is not in use. Empty when nothing limits it. |
| Vignette Color | Color | The vignette colour currently in effect. |
| Cel Outline Color | Color | The CEL outline colour currently in effect. |

## Notes

- **Ready** is false until the renderer has confirmed its first frame, and outside a running game.
- Until a new request is confirmed, the effective settings keep their last confirmed values.
