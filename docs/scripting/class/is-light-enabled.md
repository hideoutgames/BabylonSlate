---
node: light.getEnabled
---

# Is Light Enabled

Returns whether a light is on.

## Inputs

| Pin | Type |
| --- | --- |
| Target | LightComponent Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Enabled | Boolean |

## Notes

- False when **Target** is empty or has no light, which also logs an error for an empty reference.
