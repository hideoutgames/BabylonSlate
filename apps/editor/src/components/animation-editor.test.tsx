import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnimationEditor, AnimationPreview } from "./animation-editor";
import { encodeTriangleGlb } from "@babylonslate/render";

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => null,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "model-1", name: "Hero", type: "Model" },
          path: "assets/Hero.babasset",
        },
        {
          header: {
            guid: "skel-1",
            name: "Hero_Skeleton",
            type: "Skeleton",
            payload: { modelGuid: "model-1", kind: "hierarchy", boneNames: ["torso"] },
          },
          path: "assets/Hero_Skeleton.babasset",
        },
      ],
    },
    readAssetChunk: async () => null,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("AnimationEditor", () => {
  it("shows read-only clip, Model, and Skeleton fields", () => {
    render(
      <AnimationEditor
        payload={{
          clipName: "idle",
          modelGuid: "model-1",
          skeletonGuid: "skel-1",
          durationMs: 1200,
        }}
      />,
    );
    expect(screen.getByTestId("animation-editor")).toBeTruthy();
    expect(
      (screen.getByTestId("property-clipName") as HTMLInputElement).value,
    ).toBe("idle");
    expect(screen.getByTestId("property-clipName")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("property-model").textContent).toContain("Hero");
    expect(screen.getByTestId("property-skeleton").textContent).toContain(
      "Hero_Skeleton",
    );
    expect(
      (screen.getByTestId("property-durationMs") as HTMLInputElement).value,
    ).toBe("1200");
  });
});

describe("AnimationPreview", () => {
  it("toggles Show Bones on a looping preview toolbar", () => {
    const onShowBonesChange = vi.fn();
    render(
      <AnimationPreview
        payload={{
          clipName: "idle",
          modelGuid: "model-1",
          skeletonGuid: "skel-1",
        }}
        sourceBytes={encodeTriangleGlb()}
        skeletonKind="hierarchy"
        showBones={false}
        onShowBonesChange={onShowBonesChange}
      />,
    );
    expect(screen.getByTestId("animation-preview-toolbar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("animation-show-bones"));
    expect(onShowBonesChange).toHaveBeenCalledWith(true);
  });
});
