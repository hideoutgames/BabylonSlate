import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChecklistDialog, type ChecklistDialogGroup } from "./checklist-dialog";

const groups: ChecklistDialogGroup[] = [
  { id: "actor", label: "Actor", items: [
    { id: "location", label: "Location", included: true },
    { id: "scale", label: "Scale" },
    { id: "visible", label: "Visible" },
  ] },
  { id: "light", label: "Glow (Light Component)", items: [{ id: "intensity", label: "Intensity", keywords: "brightness" }] },
];

afterEach(cleanup);

describe("ChecklistDialog", () => {
  it("confirms the checked items in list order, never the included ones", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<ChecklistDialog open onOpenChange={onOpenChange} title="Add Track to Door" groups={groups} confirmLabel="Add Tracks" onConfirm={onConfirm} />);
    const confirm = screen.getByRole("button", { name: "Add Tracks" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByLabelText("Included")).toBeTruthy();
    fireEvent.click(screen.getByText("Intensity"));
    fireEvent.click(screen.getByText("Scale"));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(["scale", "intensity"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("filters by item, group and keywords, and confirms with Enter", () => {
    const onConfirm = vi.fn();
    render(<ChecklistDialog open onOpenChange={() => {}} title="Add Track" groups={groups} confirmLabel="Add Tracks" onConfirm={onConfirm} searchPlaceholder="Search Properties" />);
    const search = screen.getByLabelText("Search Properties");
    fireEvent.change(search, { target: { value: "bright" } });
    expect(screen.queryByText("Scale")).toBeNull();
    expect(screen.getByText("Intensity")).toBeTruthy();
    fireEvent.change(search, { target: { value: "actor" } });
    expect(screen.getByText("Scale")).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No Matches")).toBeTruthy();
    fireEvent.change(search, { target: { value: "vis" } });
    fireEvent.click(screen.getByText("Visible"));
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(["visible"]);
  });

  it("picks one item at a time, skips items it cannot take and runs its action row", () => {
    const onConfirm = vi.fn();
    const onAction = vi.fn();
    const onOpenChange = vi.fn();
    render(<ChecklistDialog
      open onOpenChange={onOpenChange} title="Bind to Timeline Asset" selection="single" confirmLabel="Bind" onConfirm={onConfirm}
      action={{ label: "New Timeline Asset…", onSelect: onAction, testId: "new" }}
      groups={[{ id: "timelines", label: "Timeline Assets", items: [
        { id: "hall", label: "Hall", description: "Intro, Door Open" },
        { id: "lobby", label: "Lobby", description: "No clips" },
        { id: "busy", label: "Busy", disabledReason: "Already holds a clip named Intro (Main)." },
      ] }]}
    />);
    expect(screen.getByText("Intro, Door Open")).toBeTruthy();
    expect(screen.getByText("Already holds a clip named Intro (Main).")).toBeTruthy();
    fireEvent.click(screen.getByText("Busy"));
    fireEvent.click(screen.getByText("Hall"));
    fireEvent.click(screen.getByText("Lobby"));
    expect(screen.queryByText(/selected/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bind" }));
    expect(onConfirm).toHaveBeenCalledWith(["lobby"]);
    fireEvent.click(screen.getByTestId("new"));
    expect(onAction).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
