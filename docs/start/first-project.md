# Your First Project

Create, open, save and close projects from the Homepage, the screen Haptic shows when no project is open.

## Create a project

1. On the Homepage, choose **New Project**.
2. In the **New Project** dialog, pick a starter or an installed template.
3. Enter a **Name**. If you leave it empty, Haptic uses the suggested name shown in the field.
4. Optionally pick a **Color** and an **Icon** for the project card, or choose **Upload Picture** (PNG, JPEG or WebP). After uploading, switch between the picture and an icon at any time without uploading again.
5. Optionally open **Options** to change where the project is stored and its resolution.
6. Choose **Create**. The editor opens with the **Content Browser**.

You can also start from a template directly: choose one under **Templates** in the Homepage sidebar to go straight to step 3. When you have no projects yet, the Homepage shows **Start Your First Project** with **Basic 3D**, **Basic 2D** and **Blank**, which do the same.

## Starters

| Starter | What you get |
| --- | --- |
| Blank | An empty project with one empty scene. |
| Basic 3D | A 3D scene with a sky, a sun, a camera and an animated Mannequin character, plus ready-made Input Actions and Axes (Jump, Confirm, Move, Look). |
| Basic 2D | A 2D scene with a camera and a starter Class. |
| Feature Test | A large showcase of every engine feature. Listed only when **Debug Mode** is on (see below). |

Installed templates appear under **Installed**. To add one, choose **Add Template** in the template list and pick a project ZIP made with **Export Project**. **Engine Settings > Templates** lists the templates you have.

## Options

| Option | Description |
| --- | --- |
| Location | **App Documents** (iPad, iPhone and Android) or **Projects Folder** (desktop) keeps the project in the app's own storage. **Choose Folder** asks for a folder when you choose Create. On the web, projects are stored in the browser. |
| Resolution | The game's design size for Play and exported games. Default 1920 × 1080. |
| Black Bars | Adds bars to keep the design size. Off, the game fills the window without stretching. |

Change the resolution later in **Project Settings > Rendering**. See [Where Projects Live](../projects/storage.md) for more on storage.

## Open a project

- Tap a project card to open it.
- Choose **Open** to open a project folder from elsewhere. On the web, **Open** offers **Import Folder** and **Import ZIP**, which copy the project into the browser.
- Use **Search Projects…**, **Sort** and **View** (Large Cards, Small Cards or List) to find projects.

Each card has a **Project Actions** button (also a long-press or right-click on the card) with **Open**, **Edit** (name, colour and picture) and **Remove From List**. On the web this item is **Delete**, which permanently deletes the project.

## Play it

1. In the **Content Browser**, double-tap the **main** scene to open it.
2. Choose **Play** in the toolbar.
3. Choose **Stop** to return to the editor.

## Save and close

- Choose **Save All** (<kbd>Mod</kbd>+<kbd>S</kbd>) to save every changed document and the project settings. Haptic also auto-saves. See [Undo and Saving](../editor/undo-and-saving.md).
- To close the project, choose **Settings > Project Browser** in the toolbar. Haptic returns to the Homepage.

If anything is unsaved, **Unsaved Documents** lists it. Choose **Save All**, **Discard** or **Cancel**.

## Feature Test

Feature Test is a developer starter that places every engine feature in a few scenes. It is useful for checking how a device performs.

1. Turn on **Engine Settings > Debugger > Debug Mode**.
2. Create a project from the **Feature Test** starter.
3. Choose **Debug > Run Feature Test Check…** (on phones, **More Tools** first).
4. Pick **Quick (Current Scene)**, **Full (All Scenes)**, **Benchmark** or **Breakdown**, then choose **Start**.
5. When it finishes, choose **Copy Report** to copy the plain-text results.

If the app crashes or reloads during a check, choose **Run Feature Test Check…** again: it shows the report up to where the app stopped, with what the editor held at the end, so you can still copy it.

Benchmark plays every scene at each quality level and takes about ten minutes; keep the device awake and plugged in.

Breakdown shows what each feature costs your device's GPU. It plays two scenes, measures each feature on its own between unchanged baselines, and also measures occlusion culling seen from two cameras. It needs no console commands. Choose how it measures:

- **Add One** (the default) starts from a light setup well below what the GPU can handle: the Low quality level at half resolution, without post-processing, anti-aliasing, water reflections, water refraction or captures. It turns one feature on at a time at its Medium value, so each change is that feature's own cost. The report flags **OVER CAP** when even the light setup took over 30 ms of GPU time per frame, because the costs are then unreliable.
- **Remove One** starts from the Medium quality level and turns one feature off at a time, showing what each saves there. A GPU that is already at its limit shows only whether removing a feature brought it back under, not what the feature costs.

Either way, a step whose setting already has that value is skipped, and the report says so. The report also shows how much the GPU time changed while the device warmed up.

- Halfway through, the editor reloads by itself, reopens the project and measures everything again with the other `preservebuffer` setting, then puts yours back. Choose **Cancel** in the status bar to stop at any point; the report keeps what finished.
- The report holds both rounds and compares them. It also warns when the device was still warm from a check that ended less than ten minutes earlier, and when the GPU was too busy for the costs to add up (Remove One).

A Breakdown takes about 20 minutes; keep the device awake and plugged in.
