---
node: casting.cast
---

# Cast To

Tests whether an object belongs to a class and returns it as that class if so.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Object | Object Reference | The object to test. |
| Class | Object Class | The class to test for. Objects of derived classes also pass. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when **Object** is an instance of **Class**. |
| Result | Object Reference | The same object, typed as **Class**, when the cast succeeds. Empty otherwise. |

## Notes

- Execution always continues through the single output, so check **Success** with a [**Branch**](branch.md).
- Objects of a derived class pass the test, and **Result** is empty when the cast fails.
- **Add Node** lists a Cast to row for each class, with **Class** already filled in.
