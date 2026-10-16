---
node: bt.composite.parallel
---

# Parallel

Runs all of its children at the same time.

## Notes

- It stays running until every child has succeeded, then succeeds.
- It fails as soon as any child fails, and stops the children that are still running.
- A Parallel needs at least two children.
