import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, eulerDegreesToQuaternion, identitySerializedTransform } from "@babylonslate/core";
import { copySceneActors, pasteSceneActors } from "./scene-actor-clipboard";
import { EditorSessionState } from "./editor-session-state";

describe("actor clipboard", () => {
  it("keeps a detached subtree at its original world position, rotation and scale", () => {
    const source = createDefaultScene();
    const rotation = eulerDegreesToQuaternion([0, 0, 90]);
    source.actors = [
      createActor("parent", "Outside Parent", { transform: {
        position: [100, 0, 0], rotation, scale: [2, 2, 2],
      } }),
      createActor("root", "Copied Root", { parentId: "parent", transform: {
        ...identitySerializedTransform(), position: [2, 0, 0],
      } }),
      createActor("child", "Copied Child", { parentId: "root", transform: {
        ...identitySerializedTransform(), position: [0, 3, 0],
      } }),
    ];
    const [root, child] = copySceneActors(source, ["root"]);
    expect(root!.parentId).toBeNull();
    expect(root!.transform.position[0]).toBeCloseTo(100);
    expect(root!.transform.position[1]).toBeCloseTo(4);
    expect(root!.transform.scale).toEqual([2, 2, 2]);
    rotation.forEach((value, index) => expect(root!.transform.rotation[index]).toBeCloseTo(value));
    expect(child!.parentId).toBe("root");
    expect(child!.transform.position).toEqual([0, 3, 0]);
    expect(source.actors[1]!.transform.position).toEqual([2, 0, 0]);
  });

  it("copies subtrees between scenes with new identities and internal references", () => {
    const source = createDefaultScene();
    source.actors = [
      createActor("actor-1", "Parent", { folderId: "source-folder", components: [
        { id: "focus-parent", classId: "2DFocusTargetComponent", properties: { focusRight: "actor-1" } },
      ] }),
      createActor("actor-2", "Child", { parentId: "actor-1", components: [
        { id: "cable", classId: "CableComponent", properties: { targetActorId: "actor-1", targetComponentId: null } },
        { id: "constraint", classId: "PhysicsConstraintComponent", properties: { targetActorId: "outside" } },
      ] }),
      createActor("outside", "Outside"),
    ];
    const store = new EditorSessionState();
    store.copyActors(copySceneActors(source, ["actor-1"]), false);
    source.actors[0]!.name = "Changed Later";
    const destination = createDefaultScene();
    destination.actors = [createActor("actor-1", "Destination")];
    const copies = pasteSceneActors(destination, store.readCopiedActors(false));
    const [parent, child] = copies;
    expect(copies).toHaveLength(2);
    expect(new Set([...destination.actors, ...copies].map((actor) => actor.id)).size).toBe(3);
    expect(parent).toMatchObject({ name: "Parent Copy", parentId: null, folderId: null });
    expect(child).toMatchObject({ parentId: parent!.id, folderId: null });
    expect(child!.components[0]!.properties.targetActorId).toBe(parent!.id);
    expect(parent!.components[0]!.properties.focusRight).toBe(parent!.id);
    expect(child!.components[1]!.properties.targetActorId).toBeNull();
    expect(store.readCopiedActors(true)).toEqual([]);
    expect(new EditorSessionState().readCopiedActors(false)).toEqual([]);
    // Pasting never consumes or edits the snapshot.
    const repeated = pasteSceneActors({ ...destination, actors: [...destination.actors, ...copies] }, store.readCopiedActors(false));
    expect(repeated[0]!.name).toBe("Parent Copy 2");
    expect(repeated[1]!.parentId).toBe(repeated[0]!.id);
  });
});
