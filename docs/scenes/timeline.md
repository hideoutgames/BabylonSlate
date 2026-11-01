# Timeline

Timeline mode is where a Scene or Scene Layer keeps its Timeline Clips: named clips that animate the document's actors over time.

## Open Timeline mode

With a Scene or Scene Layer open, pick **Timeline** in the **Scene Mode** picker in the toolbar, or press <kbd>Shift</kbd>+<kbd>5</kbd>. **Design** returns to ordinary editing. Switching modes keeps the scene, its selection and its undo history, and each mode keeps its own window layout.

| Window | Shows |
| --- | --- |
| **Viewport** | The scene, as in Design mode. |
| **Outliner** | The document's actors, as in Design mode. |
| **Clips** | The document's Timeline Clips. |
| **Timeline** | The clip selected in **Clips**: its actors, their tracks and keys. |
| **Inspector** | The selection, as in Design mode. |

**Output Log** and **Compiler Results** open from **Windows**, tabbed with the Timeline.

## Manage clips

- Tap **New Clip** in **Clips** to add a clip. A new clip is 5 seconds long at 30 frames per second.
- Tap a clip to show it in the **Timeline**.
- Right-click or long-press a clip for **Rename**, **Duplicate**, **Copy**, **Paste** and **Delete**. Right-click or long-press the empty part of the list to paste.
- Rename a clip by double-clicking or double-tapping its name, or with <kbd>F2</kbd>.

Clip names are unique within the document: a name that is taken, a duplicate or a pasted clip gets a number, such as **Intro 2**. A copied clip can be pasted into another Scene or Scene Layer. Every change is one step of the document's undo history.

## Add actors and tracks

A clip animates actors through tracks. Each actor in the clip has a row in the **Timeline**, with a row for each of its tracks below it.

- While the **Timeline** shows a clip, drag an actor from the **Outliner** onto it, or open the actor's **⋯** menu in the **Outliner** and choose **Add to Timeline Clip**. Actors in the clip show a diamond in the **Outliner**.
- In the **Timeline** toolbar, **Track** adds the actors selected in the viewport or **Outliner** (<kbd>Shift</kbd>+<kbd>A</kbd>), or opens **Actor From Outliner…**, a list of the document's actors to check and add.
- Tap **+** on an actor's row to choose its tracks. The **Add Track** dialog lists what a track can animate; properties the clip already animates are checked. Check one or more and tap **Add Tracks**.

| Group | Properties |
| --- | --- |
| **Actor** | **Location**, **Rotation**, **Scale** and **Visible**. |
| **Class Variables** | The actor's Class variables (inherited ones too) of a single Bool, Int, Float, String, Vector 2, Vector 3, Rotator, Color, Enum or Asset value. |
| A component | The properties Play can change while the game runs: for example a Light's **Intensity** and **Color**, a Mesh's **Cast Shadows** and **Material**, an Audio component's **Volume**, and the opacity, tint, offset, size and text values of 2D components. |

Right-click or long-press a track or an actor's row for its menu:

| Row | Menu |
| --- | --- |
| Track | **Set Key**, **Mute Track** (a muted track keeps its keys but does not animate), **Copy Track**, **Select All Keys**, **Reveal in Outliner**, **Move Up**, **Move Down** and **Delete Track**. |
| Actor | **Add Track…**, **Set Key**, **Paste Track** (a copied track goes onto the same property of this actor, replacing that track's keys), **Select All Keys**, **Reveal in Outliner**, **Move Up**, **Move Down** and **Remove From Clip**. |

## Keys

The ruler above the tracks shows seconds, and frames when you zoom in. The playhead marks the current time, and each track shows its value there.

- Drag along the ruler to move the playhead. With the ruler focused, the arrow keys step one frame and <kbd>Home</kbd> and <kbd>End</kbd> go to the start and end.
- Tap the diamond at the end of a track's row to set a key at the playhead with the value shown; tap it again to remove that key. **Set Key** (<kbd>K</kbd>) keys the selected track, or every track of the selected actor.
- **Previous Key** (<kbd>[</kbd>) and **Next Key** (<kbd>]</kbd>), and the buttons beside **Play**, move the playhead to the nearest key.
- Tap a key to select it; <kbd>Shift</kbd> adds to the selection and <kbd>Ctrl</kbd> or <kbd>Command</kbd> toggles a key. Drag across empty space to select the keys inside, or on a touch screen hold, then drag. A key on an actor's row stands for all of that actor's keys at that time.
- Drag selected keys to move them. With **Snap to Frames** on, they land on whole frames; hold <kbd>Alt</kbd> to place them between frames. A key moved onto another key replaces it, and keys stay within the clip.
- **Delete** removes the selected keys, or the selected track or actor when no key is selected. **Copy** and **Paste** copy keys to the playhead, also into another clip that animates the same properties. **Duplicate** pastes a copy of the selected keys at the playhead.
- Right-click a key, or hold a finger on it, for **Go To Key**, **Interpolation**, **Cut**, **Copy**, **Paste**, **Duplicate** and **Delete**; on a touch screen **Select** adds the key to the selection. The menu acts on all selected keys when the key is one of them.
- <kbd>Ctrl</kbd>+scroll or <kbd>Command</kbd>+scroll, or a pinch, zooms the time scale; <kbd>Shift</kbd>+scroll pans it, and **Zoom To Fit** shows the whole clip again. On a touch screen, drag empty space to scroll the tracks.
- Drag the clip's end on the ruler, where the hatching starts, to change its **Length**.

Keys are drawn by how the value moves to the next key: a circle eases smoothly (**Auto**), a diamond moves in a straight line (**Linear**), a square holds until the next key (**Constant**), and an hourglass follows an easing curve. True or false values, whole numbers, text, enums and assets always hold. Color tracks show their colours across the clip.

**Play** in the **Timeline** toolbar moves the playhead through the clip at its **Play Rate**; **Loop Preview** repeats it. The toolbar also sets the clip's **Length** and **Frame Rate**. Every edit is one step of the document's undo history, and dragging keys or the clip's end is a single step.

## Curves

**Curves** in the **Timeline** toolbar switches from keys to curves: pick a Float, Vector, Rotator or Color track on the left to edit its curve (each axis or colour channel as its own line), and **Keys** switches back. The track selected in the keys view opens in the curves view.

Drag a key to change its time and value; times stay within the clip, and on whole frames while **Snap to Frames** is on. Double-click empty space, or hold a finger on it and choose **Add Key Here**, to add a key. Set a key's interpolation to **Custom** to drag its tangent handles and shape the curve on either side. A track holds its first and last values before and after its keys. Each change is one step of the undo history.

## Preview in the viewport

While a clip is selected, the viewport shows the scene as the clip has it at the playhead, and follows the playhead as you scrub or play. A note in the viewport's corner names the clip and the time. The preview never changes the scene: switching back to **Design** shows the actors where you placed them.

Moving, rotating or scaling an actor with the viewport gizmo works on what the clip animates:

- A channel the clip has no track for (for example **Scale** when only **Location** is animated) changes the actor itself, as in Design mode.
- With **Auto Key** on in the **Timeline** toolbar, a channel that has a track gets a key at the playhead with the new value.
- With **Auto Key** off, the change is only previewed and the track's key button turns amber. Tap it, or use **Set Key**, to keep the change as a key; moving the playhead discards it.

## Inspector

While a clip is selected, the **Inspector** edits it instead of the actor selection:

- **Key**: the selected key's track, **Time** (with its frame; a new time lands on the nearest frame), **Value** and **Interpolation**. With several keys selected, **Interpolation** sets theirs together.
- **Track**: the selected track's property, type and number of keys, and **Muted**.
- **Timeline Clip**: **Name**, **Length**, **Frame Rate**, **Play Rate**, **Loop Mode**, **Auto Play** and **When Finished**.

**Interpolation** offers **Constant**, **Linear**, **Auto**, **Ease In**, **Ease Out**, **Ease In Out** and every other easing curve. Enum and Asset values are set on the property itself, then keyed.

