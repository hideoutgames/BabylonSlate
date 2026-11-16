import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FootPlacementFeet } from "./foot-placement-feet";

afterEach(cleanup);

describe("Foot Placement feet", () => {
  it("adds a foot from the Skeleton's bones, offers only bones not yet listed, and removes one", () => {
    let saved: Record<string, unknown> = { feet: ["foot.l"] };
    function Editor() {
      const [data, setData] = useState(saved);
      return (
        <FootPlacementFeet
          data={data}
          bones={["hips", "foot.l", "foot.r"]}
          onPatch={(patch) => {
            saved = { ...data, ...patch };
            setData(saved);
          }}
        />
      );
    }
    render(<Editor />);
    fireEvent.click(screen.getByTestId("foot-placement-feet-add"));
    const picker = screen.getByTestId("foot-placement-feet-picker");
    expect(picker.textContent).toContain("foot.r");
    expect(picker.textContent).not.toContain("foot.l");
    fireEvent.click(screen.getByText("foot.r"));
    expect(saved.feet).toEqual(["foot.l", "foot.r"]);
    fireEvent.click(screen.getByTestId("foot-placement-feet-remove-foot.l"));
    expect(saved.feet).toEqual(["foot.r"]);
  });
});
