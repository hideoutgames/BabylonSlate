# Skeleton

The bones of a rig: their names, how they nest and their rest pose. Every Model and Animation with that rig shares one Skeleton, so any [Animation](animation.md) on it plays on any of its Models.

## Import

Skeletons are not created from **New Asset**. Importing a rigged GLB, glTF or FBX model creates one, either from the model's skin or, when the model is built from parented mesh parts, from that hierarchy. A file with animations and no mesh gets one from its animated nodes. See [Importing Assets](../editor/importing.md).

A skinned model, or a file with animations and no mesh, whose rig matches a Skeleton already in the project joins that Skeleton instead of getting its own. Rigs match when:

- the bones have the same names and parents, in any order;
- the rest pose is the same, within a small tolerance;
- one side may have an extra root bone, such as an armature node, that the other lacks.

A rig with only some of the Skeleton's bones joins it. A rig with all of them and more joins it and adds its extra bones. A file with animations and no mesh has no rest pose for the parts its clips animate, so those parts are not compared; the first Model that joins fills them in.

A rig with the same bone names but other proportions, such as a larger version of a character, gets its own Skeleton. Use **Retarget…** to play its clips on the other one. Models built from parented mesh parts always keep their own Skeleton.

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** shows the Preview Model's bones in their rest pose: a tapered bone from each joint to each of its children and a ball at every joint. If it cannot load the mesh, it shows **No Mesh**.
- The **Inspector** shows the settings below, then the bones as a tree. Select a bone to highlight it, and the bones it leads to, in the **Preview**, and to show its parent and rest pose under the tree; select it again to clear the highlight. A rest value that only an animation file has supplied shows **Unknown**.

## Settings

| Setting | Description |
| --- | --- |
| Kind | **Skin** for a rigged model, or **Hierarchy** for parented mesh parts or an animation file. |
| Preview Model | The Model the **Preview** draws. You can pick any Model on this Skeleton. |
| Models, Animations, Bones | How many Models and Animations use the Skeleton, and how many bones it has. |

## Move a Model onto another Skeleton

Rigs imported before a matching Skeleton existed keep their own. To merge them, right-click the Model in the **Content Browser**, choose **Assign Skeleton…** and pick a Skeleton. The list holds only Skeletons whose bones match. The Model and its Animations move onto it; extra bones the Model has are added to it. The changed assets are marked unsaved until you save.

## Use it

- To reuse [Animation](animation.md) clips on a character with another Skeleton, select the clips in the **Content Browser**, choose **Retarget…** and pick the target Skeleton.
- To attach an actor to a bone, use [Attach To Bone](../scripting/class/attach-to-bone.md).

## Related

- [Models](../graphics/models.md)
- [Animation Graph](animation-graph.md)
