import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssetLoadingField } from "./asset-loading-field";

afterEach(cleanup);

describe("AssetLoadingField", () => {
  it("defaults to Soft, shows a stored Hard policy and reports the chosen policy", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AssetLoadingField onChange={onChange} data-testid="loading" />);
    expect(screen.getByTestId("loading").textContent).toContain("Soft (Load On Demand)");
    expect(screen.getByLabelText("Loading")).toBe(screen.getByTestId("loading"));
    fireEvent.click(screen.getByTestId("loading"));
    const hard = screen.getByRole("option", { name: "Hard (Load With Owner)" });
    fireEvent.pointerDown(hard);
    fireEvent.click(hard);
    expect(onChange).toHaveBeenCalledWith("hard");

    rerender(<AssetLoadingField value="hard" onChange={onChange} data-testid="loading" />);
    expect(screen.getByTestId("loading").textContent).toContain("Hard (Load With Owner)");
    fireEvent.click(screen.getByTestId("loading"));
    const soft = screen.getByRole("option", { name: "Soft (Load On Demand)" });
    fireEvent.pointerDown(soft);
    fireEvent.click(soft);
    expect(onChange).toHaveBeenLastCalledWith("soft");
  });

  it("describes the policies for assistive technology and cannot be opened while disabled", () => {
    render(<AssetLoadingField value="hard" disabled onChange={vi.fn()} data-testid="loading" />);
    const trigger = screen.getByTestId("loading") as HTMLButtonElement;
    expect(document.getElementById(trigger.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/Hard assets load with their owner/);
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("option")).toBeNull();
  });
});
