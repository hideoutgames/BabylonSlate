# Selector

Runs its children from left to right until one succeeds.

## Notes

- It succeeds as soon as a child succeeds, and fails if every child fails.
- Use it to try options in priority order, with the preferred option on the left.
- A Selector with no children fails.
