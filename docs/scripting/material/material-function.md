# Material Function

Runs a Material Function, with pins that match the function's inputs and outputs.

## Settings

| Setting | Description |
| --- | --- |
| Material Function | The Material Function asset to call. |

## Notes

- Choose the function in the **Inspector**. Changing it removes the node's existing connections.
- A function can call other functions, but not itself, directly or in a loop.
- Every node inside the function must be allowed in the domain of the material that calls it.
