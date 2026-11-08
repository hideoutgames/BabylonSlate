# Random numbers

The **Random** nodes return random values: numbers, true or false, directions, and items of an Array. Every value comes from a seed, so the same seed always gives the same values, on every device.

## The global seed

The everyday Random nodes, such as [Random Float](class/random-float.md), [Random Int](class/random-int.md) and [Random Array Item](class/random-array-item.md), draw from one global seed.

- Each Play session, and each run of an exported game, starts the global seed afresh, so these nodes return different values every time.
- [Set Global Randomization Seed](class/set-global-randomization-seed.md) makes them repeatable: after it runs, they return the same values for the same **Seed**.
- [Get Global Randomization Seed](class/get-global-randomization-seed.md) returns the global seed, with how many values have been drawn from it so far as its **Step**.

## Seeds

A **Seed** is a built-in Structure with two fields:

| Field | Type | Holds |
| --- | --- | --- |
| Seed | String | The text that picks the sequence. Any text works, such as `Level 3` or `12345`. |
| Step | Int | How many values have been drawn from the sequence so far. |

Build one with **Make Seed** and read it with **Break Seed** or [Get Step Count](class/get-step-count.md). A new Seed variable starts with empty text at Step 0.

## Seeded Random nodes

Every Random node has a **Seeded** version, such as [Seeded Random Float](class/seeded-random-float.md), that draws from a Seed of its own instead of the global one.

- Its **Seed** input is a [reference pin](pin-types.md#reference-pins): connect a Seed variable. The node draws from that variable and moves its **Step** on, so the next draw continues the sequence.
- Each value drawn is one step. [Seeded Random Unit Vector](class/seeded-random-unit-vector.md) takes two, a Vector In Range three, and a shuffle one for each item after the first. Picking from an empty Array, or between two equal numbers, takes none.
- Seeded draws never touch the global seed, and the global seed's draws never touch a Seed variable. Give each system its own Seed variable, such as one for loot and one for level generation, so they cannot change each other's values.

To pass a Seed into your own function and have the function's draws move it on, make that function input [Pass-By-Reference](functions.md#pass-by-reference).

## Save and continue a sequence

1. Store the Seed variable, or the result of **Get Global Randomization Seed**, in a [save game](save-games.md).
2. After loading, set the variable to the saved Seed, or pass it to **Set Global Randomization Seed**.

The next value drawn is the one that would have come next in the saved game, because the Seed's **Step** says how far along the sequence was.

## Nodes

| Node | Returns |
| --- | --- |
| [Random Float](class/random-float.md) | A number from 0 up to, but not including, 1. |
| [Random Int](class/random-int.md) | A whole number between **Min** and **Max**, both included. |
| [Random Bool](class/random-bool.md), [Random Bool With Weight](class/random-bool-with-weight.md) | True or false, with equal chance or with the chance **Weight**. |
| [Random Unit Vector](class/random-unit-vector.md) | A random direction of length 1. |
| [Random Integer In Range](class/random-int-in-range.md), [Random Float In Range](class/random-float-in-range.md), [Random Vector 2 In Range](class/random-vector2-in-range.md), [Random Vector In Range](class/random-vector-in-range.md), [Random Rotator In Range](class/random-rotator-in-range.md) | A value inside a range. See [Curves and ranges](curves-and-ranges.md). |
| [Random Array Item](class/random-array-item.md) | A random item of an Array and its index. |
| [Shuffle Array](class/shuffle-array.md) | The Array's items in a random order. |
| [Set Global Randomization Seed](class/set-global-randomization-seed.md), [Get Global Randomization Seed](class/get-global-randomization-seed.md) | Set or read the global seed. |
| [Get Step Count](class/get-step-count.md) | How many values have been drawn from a Seed. |

Each draw also has a Seeded version, listed under **Random** in the [Class node reference](class/index.md#random).
