# Behaviour Tree Nodes

Composites, tasks, decorators and services you can add to a Behaviour Tree.

## Composites

| Node | Description |
| --- | --- |
| [Parallel](parallel.md) | Runs all of its children at the same time. |
| [Selector](selector.md) | Runs its children from left to right until one succeeds. |
| [Sequence](sequence.md) | Runs its children from left to right until one fails. |

## Tasks

| Node | Description |
| --- | --- |
| [Fail](fail.md) | Finishes immediately and reports failure to its parent. |
| [Move To](move-to.md) | Moves the actor to a world position along the navigation mesh. |
| [Move To Blackboard Key](move-to-blackboard-key.md) | Moves the actor to the position stored in a Blackboard key. |
| [Play Animation](play-animation.md) | Plays an Animation or Sprite Animation asset once, then succeeds. |
| [Play Sound](play-sound.md) | Plays an Audio asset from the actor and succeeds. |
| [Rotate To Face](rotate-to-face.md) | Turns the actor to face a world position. |
| [Set Blackboard](set-blackboard.md) | Writes a value to a Blackboard key and succeeds. |
| [Succeed](succeed.md) | Finishes immediately and reports success to its parent. |
| [Wait](wait.md) | Waits for a set time, then succeeds. |

## Decorators

| Node | Description |
| --- | --- |
| [Blackboard Is Set](blackboard-is-set.md) | Lets a node run only while a Blackboard key has a value. |
| [Compare Blackboard Value](compare-blackboard-value.md) | Lets a node run only while a Blackboard key compares true against a value. |
| [Cooldown](cooldown.md) | Stops a node from running again for a set time after it finishes. |
| [Loop](loop.md) | Repeats the node it is attached to. |
| [Time Limit](time-limit.md) | Fails a node if it runs for longer than a set time. |

## Services

| Node | Description |
| --- | --- |
| [Set Blackboard](set-blackboard-service.md) | Writes a value to a Blackboard key at regular intervals while its node is active. |
