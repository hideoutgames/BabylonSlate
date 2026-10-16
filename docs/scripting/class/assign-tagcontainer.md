---
node: tags.assignContainer
---

# Assign TagContainer

Assigns a TagContainer to a variable and returns the assigned TagContainer.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | TagContainer | The TagContainer variable to change, wired from its Get node. |
| Value | TagContainer |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Value | TagContainer | The TagContainer that was assigned. |

## Notes

- Connect a variable's Get node to **Target**; the new container is written back to that variable.
- Use it to keep the result of [**Add Tag**](add-tag.md), [**Remove Tag**](remove-tag.md) or [**Union Tags**](union-tags.md), which return new containers.
