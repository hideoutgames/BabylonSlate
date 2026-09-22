import { afterEach, describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene } from "@babylonjs/core";
import {
  SHARED_OUTLINE_ATTRIBUTE,
  SharedOutlineOwner,
  type SharedOutlineContribution,
} from "./shared-outline";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function setup() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const owner = SharedOutlineOwner.forScene(scene);
  return { scene, owner, view: owner.createView("editor") };
}
const style = { kind: "component", color: [1, 0, 0], width: 2 } as const;

describe("shared outline admission", () => {
  it("rejects identity overflow without replacing the accepted contribution", () => {
    const { owner, view } = setup();
    const accepted: SharedOutlineContribution = {
      ...style,
      targets: Array.from({ length: 65_535 }, (_, index) => ({ key: `actor-${index}`, meshes: [] })),
    };
    view.setContribution("authored", accepted);
    const revision = view.revision;
    expect(() => view.setContribution("authored", {
      ...accepted,
      targets: [...accepted.targets, { key: "overflow", meshes: [] }],
    })).toThrow(/capacity/i);
    expect(view.revision).toBe(revision);
    expect(owner.identityForKey("overflow")).toBe(0);
    expect(view.contributions.get("authored")?.targets).toHaveLength(65_535);
  });

  it("rolls back new registrations when another source already owns the attribute", () => {
    const { scene, owner, view } = setup();
    const acceptedSource = MeshBuilder.CreateBox("accepted", {}, scene);
    const accepted = acceptedSource.createInstance("accepted-instance");
    view.setContribution("authored", { ...style, targets: [{ key: "accepted", meshes: [accepted] }] });
    const acceptedIdentity = owner.identityFor(accepted);
    const newSource = MeshBuilder.CreateBox("new-source", {}, scene);
    const newInstance = newSource.createInstance("new-instance");
    const occupiedSource = MeshBuilder.CreateBox("occupied", {}, scene);
    const occupied = occupiedSource.createInstance("occupied-instance");
    occupiedSource.registerInstancedBuffer(SHARED_OUTLINE_ATTRIBUTE, 1);
    occupiedSource.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = 47;
    const revision = view.revision;

    expect(() => view.setContribution("other", { ...style, targets: [
      { key: "new", meshes: [newInstance] },
      { key: "occupied", meshes: [occupied] },
    ] })).toThrow(/another owner/i);
    expect(view.revision).toBe(revision);
    expect(view.contributions.has("other")).toBe(false);
    expect(owner.identityFor(accepted)).toBe(acceptedIdentity);
    expect(accepted.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(acceptedIdentity);
    expect(newSource.instancedBuffers?.[SHARED_OUTLINE_ATTRIBUTE]).toBeUndefined();
    expect(occupiedSource.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(47);
    expect(owner.identityForKey("new")).toBe(0);
  });
});
