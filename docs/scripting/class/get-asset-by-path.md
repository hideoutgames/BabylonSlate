# Get Asset By Path

Looks up an asset by its full storage path and returns its details.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Path | String | The full storage path, such as assets/Weapons/Rifle.class.babasset. Matching is case sensitive. |

## Outputs

| Pin | Type |
| --- | --- |
| Asset Data | AssetData |
| Found | Boolean |

## Notes

- **Found** is false when no packaged asset has that path.
- Use **Break Asset Data** to read the name, folder, type and Class.
