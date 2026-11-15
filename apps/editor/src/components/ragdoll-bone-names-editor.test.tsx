import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { RagdollBoneNamesEditor } from "./ragdoll-bone-names-editor";

const assets = [
  { path: "assets/Hero.hasset", header: { guid: "hero", name: "Hero", type: "Model", payload: { materialSlots: [], skeletonGuid: "rig" } } },
  { path: "assets/Rig.hasset", header: { guid: "rig", name: "Hero_Skeleton", type: "Skeleton", payload: {
    bones: [{ name: "Hips" }, { name: "Spine", parent: "Hips" }, { name: "Head", parent: "Spine" }],
    sockets: [{ name: "Grip", bone: "Head" }],
  } } },
];

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: { list: () => assets, getByGuid: (guid: string) => assets.find((asset) => asset.header.guid === guid) },
  })),
);

afterEach(cleanup);

describe("ragdoll bone selection", () => {
  it("persists an exact-name subset, rejects duplicate drafts, and restores all bones when cleared", () => {
    let saved: string[] = [];
    function Editor() {
      const [boneNames, setBoneNames] = useState(saved);
      return <RagdollBoneNamesEditor boneNames={boneNames} onChange={(names) => { saved = names; setBoneNames(names); }} />;
    }
    render(<Editor />);
    const allBones = "Uses the complete skeleton.";
    expect(screen.getByText(allBones)).toBeTruthy();
    const add = (name: string) => {
      fireEvent.change(screen.getByTestId("ragdoll-bone-names-add-value"), { target: { value: name } });
      fireEvent.click(screen.getByTestId("ragdoll-bone-names-add"));
    };
    add("Hips");
    add("Spine");
    expect(saved).toEqual(["Hips", "Spine"]);
    expect(screen.queryByText(allBones)).toBeNull();
    add("Spine");
    expect(saved).toEqual(["Hips", "Spine"]);
    expect(screen.getByText(/must be unique/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-2-remove"));
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-1-remove"));
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-0-remove"));
    expect(saved).toEqual([]);
    expect(screen.queryByText(/must be unique/)).toBeNull();
    expect(screen.getByText(allBones)).toBeTruthy();
  });

  it("adds bones from the actor's Model's Skeleton when it has one, and never offers sockets or listed bones", () => {
    let saved: string[] = ["Hips"];
    function Editor() {
      const [boneNames, setBoneNames] = useState(saved);
      return (
        <RagdollBoneNamesEditor
          boneNames={boneNames}
          components={[{ classId: "MeshComponent", properties: { assetGuid: "hero" } }]}
          onChange={(names) => { saved = names; setBoneNames(names); }}
        />
      );
    }
    render(<Editor />);
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-add"));
    const picker = screen.getByTestId("ragdoll-bone-names-picker");
    expect(picker.textContent).toContain("Spine");
    expect(picker.textContent).toContain("Head");
    expect(picker.textContent).not.toContain("Grip");
    fireEvent.click(screen.getByText("Spine"));
    expect(saved).toEqual(["Hips", "Spine"]);
  });
});
