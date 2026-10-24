---
node: render.recaptureReflectionProbes
---

# Recapture Reflection Probes

Recaptures every Reflection Probe in the play world.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Use it after moving or showing static scenery. Probes capture once the world settles, one probe per frame.
- Probes capture static actors only, so moving characters never need a recapture.
