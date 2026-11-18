import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Diagnostic } from "@haptic/scripting";
import { PlayBlockedDialog } from "./play-blocked-dialog";

const error = (code: string, message: string): Diagnostic => ({ severity: "error", code, message, assetGuid: "a", graphId: "g" });
const diagnostics = [
  error("play.missing_asset", "2D Rich Text on \"Dialogue\" in Scene Layer \"HUD\" uses an asset that does not exist: X (Text)."),
  { ...error("compile.warning", "Unused variable"), severity: "warning" as const },
];

afterEach(cleanup);

describe("PlayBlockedDialog", () => {
  it("offers Play Anyway for compile errors and goes to a row's source", () => {
    const onPlayAnyway = vi.fn();
    const onNavigate = vi.fn();
    render(<PlayBlockedDialog open diagnostics={diagnostics} title="Compile Errors" description="Fix errors before Play."
      onOpenChange={() => {}} onNavigate={onNavigate} onPlayAnyway={onPlayAnyway} />);
    const dialog = screen.getByRole("alertdialog", { name: "Compile Errors" });
    // Only errors stop Play, so only they are listed.
    const rows = within(dialog).getAllByTestId("play-blocked-row");
    expect(rows.map((row) => row.textContent)).toEqual([`play.missing_asset: ${diagnostics[0]!.message}`]);
    fireEvent.click(rows[0]!);
    expect(onNavigate).toHaveBeenCalledWith(diagnostics[0]);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Play Anyway" }));
    expect(onPlayAnyway).toHaveBeenCalledTimes(1);
  });

  it("offers only Close when Play cannot run", () => {
    const onOpenChange = vi.fn();
    render(<PlayBlockedDialog open diagnostics={diagnostics} title="Play Could Not Start" description="Required assets are missing."
      onOpenChange={onOpenChange} onNavigate={() => {}} />);
    const dialog = screen.getByRole("alertdialog", { name: "Play Could Not Start" });
    expect(within(dialog).getByText("Required assets are missing.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Play Anyway" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});
