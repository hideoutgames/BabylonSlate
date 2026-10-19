# Preview Build

Preview Build packages your game the way Export Game does and runs it inside the editor, so you can test the real build before you publish.

## Turn it on

1. Open the **Debug** menu next to **Play**.
2. Under **Play Mode**, choose **Preview Build**. You cannot change it while a game is running or preparing.
3. The **Play** button now reads **Preview** (**Build** on phones). Tap it to start.

Choose **Play** under **Play Mode** to return to normal Play.

## What happens when you start

1. If anything is unsaved, Haptic asks you to save, because Preview Build uses the saved project. Choose **Save & Preview** or **Cancel**.
2. The **Preparing Preview** dialog steps through **Saving**, **Collecting Assets**, **Compiling**, **Writing Pack** and **Launching**. You can cancel until the game launches.
3. The packaged game opens over the editor.

If packaging fails, **Preview Build Failed** names the step and the reason, with **Retry** and **Close**. Warnings, such as a high file count, go to the **Output Log**.

The game starts from the open scene while **Start In Open Scene** is on, and from the **Startup Scene** otherwise. Without a usable scene, Haptic asks you to set a Startup Scene.

## While it runs

The toolbar over the game shows the controls you enabled under **Debug > Overlays**. Hover or long-press a button to see its name.

| Control | Use |
| --- | --- |
| **Profiler**, **Capture Frame** | Record performance. See [Profiler](../debugging/profiler.md). |
| **Stats** | Frame rate and timings. |
| **Console** | Runs [console commands](../debugging/console.md), including debug-only ones. |
| **Stop** | Ends the preview and returns to the editor. |

There are no Pause, Step or Inspector buttons. Use the `pause`, `resume` and `step` commands in the console instead.

When you stop a preview that reported errors or warnings, the **Preview Session Report** lists them and opens the asset behind each one. See [After Play](../debugging/index.md).

## How it differs from Play and Export Game

| | Play | Preview Build | Export Game |
| --- | --- | --- | --- |
| Uses unsaved edits | Optional | No | No |
| Starts from | Open scene or Startup Scene | Open scene or Startup Scene | Startup Scene |
| Development Only nodes | Kept | Kept | Only with **Bundle Debugger** |
| Debug-only console commands | Yes | Yes | Only with **Bundle Debugger** |

Preview Build packs textures uncompressed, while Export Game uses compressed textures where they exist. Texture memory and loading times can therefore differ from the exported game.

## Related

- [Publishing](index.md)
- [Debugging](../debugging/index.md)
