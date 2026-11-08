---
node: tags.getActorTags
---

# Get Actor Tags

Returns the actor's Tags: its Class's Tags, the placed actor's own, or what scripts set since.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Tags | TagContainer |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- An actor starts with the **Tags** of its Class's **Actor Defaults**, or the ones set on the placed actor in its **Inspector**. See [Tags](../tags.md#actor-tags).
- Returns an empty TagContainer for a missing actor.
