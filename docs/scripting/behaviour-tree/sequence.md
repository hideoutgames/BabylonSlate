# Sequence

Runs its children from left to right until one fails.

## Notes

- It succeeds only if every child succeeds, and fails as soon as one child fails.
- Use it for steps that must happen in order.
- A Sequence with no children succeeds.
