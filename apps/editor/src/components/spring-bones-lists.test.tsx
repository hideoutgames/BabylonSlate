import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { normalizeAnimSpringBoneSettings } from "@haptic/core";
import { SpringBonesLists } from "./spring-bones-lists";

afterEach(cleanup);

describe("Spring Bones lists", () => {
  it("excludes a bone and adds, edits and removes a collider, picking bones from the Skeleton", () => {
    let saved: Record<string, unknown> = { bone: "Tail1" };
    function Editor() {
      const [data, setData] = useState(saved);
      return (
        <SpringBonesLists
          data={data}
          bones={["Hips", "Tail1", "Tail2"]}
          onPatch={(patch) => {
            saved = { ...data, ...patch };
            setData(saved);
          }}
        />
      );
    }
    render(<Editor />);
    fireEvent.click(screen.getByTestId("spring-bones-exclude-add"));
    fireEvent.click(within(screen.getByTestId("spring-bones-exclude-picker")).getByText("Tail2"));
    expect(normalizeAnimSpringBoneSettings(saved).excludeBones).toEqual(["Tail2"]);
    fireEvent.click(screen.getByTestId("spring-collider-add"));
    fireEvent.click(within(screen.getByTestId("spring-collider-picker")).getByText("Hips"));
    expect(normalizeAnimSpringBoneSettings(saved).colliders).toEqual([
      { kind: "sphere", bone: "Hips", offset: [0, 0, 0], radius: 0.1, length: 0.2, axis: "y" },
    ]);
    // A sphere has no axis; a capsule shows its Length and Axis.
    expect(screen.queryByTestId("property-row-spring-collider-0-axis")).toBeNull();
    saved = { ...saved, colliders: [{ ...normalizeAnimSpringBoneSettings(saved).colliders[0], kind: "capsule" }] };
    cleanup();
    render(<Editor />);
    expect(screen.getByTestId("property-row-spring-collider-0-length")).toBeTruthy();
    expect(screen.getByTestId("property-row-spring-collider-0-axis")).toBeTruthy();
    fireEvent.click(screen.getByTestId("spring-collider-remove-0"));
    expect(normalizeAnimSpringBoneSettings(saved).colliders).toEqual([]);
    fireEvent.click(screen.getByTestId("spring-bones-exclude-remove-Tail2"));
    expect(normalizeAnimSpringBoneSettings(saved).excludeBones).toEqual([]);
  });
});
