import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { RagdollBoneNamesEditor } from "./ragdoll-bone-names-editor";

afterEach(cleanup);

describe("ragdoll bone selection", () => {
  it("persists an exact-name subset, rejects duplicate drafts, and restores all bones when cleared", () => {
    let saved: string[] = [];
    function Editor() {
      const [boneNames, setBoneNames] = useState(saved);
      return <RagdollBoneNamesEditor boneNames={boneNames} onChange={(names) => { saved = names; setBoneNames(names); }} />;
    }
    render(<Editor />);
    const add = (name: string) => {
      fireEvent.change(screen.getByTestId("ragdoll-bone-names-add-value"), { target: { value: name } });
      fireEvent.click(screen.getByTestId("ragdoll-bone-names-add"));
    };
    add("Hips");
    add("Spine");
    expect(saved).toEqual(["Hips", "Spine"]);
    add("Spine");
    expect(saved).toEqual(["Hips", "Spine"]);
    expect(screen.getByText(/must be unique/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-2-remove"));
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-1-remove"));
    fireEvent.click(screen.getByTestId("ragdoll-bone-names-0-remove"));
    expect(saved).toEqual([]);
    expect(screen.queryByText(/must be unique/)).toBeNull();
  });
});
