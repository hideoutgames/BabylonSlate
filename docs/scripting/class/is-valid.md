---
node: actor.isValid
---

# Is Valid

Returns true when an object reference points to an object that still exists. It returns false when the reference is empty or the object has been destroyed.

## Inputs

| Pin | Type |
| --- | --- |
| Object | Object Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Use it before reading from a reference that may not be set, such as the result of [**Get Actor Of Class**](get-actor-of-class.md).
- A reference you stored keeps pointing at its object after [Destroy Actor](destroy-actor.md) removes it. Is Valid returns false for it once the removal has happened, at the end of the current update step.
