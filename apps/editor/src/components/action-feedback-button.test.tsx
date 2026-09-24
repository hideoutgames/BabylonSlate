import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveAllIcon, Undo2Icon } from "lucide-react";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { ActionFeedbackButton } from "./action-feedback-button";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function saveButton(action: () => Promise<boolean>, key = "project-a") {
  return (
    <TooltipProvider>
      <ActionFeedbackButton
        key={key}
        icon={SaveAllIcon}
        iconOnly
        label="Save All"
        onAction={action}
      />
    </TooltipProvider>
  );
}

describe("ActionFeedbackButton", () => {
  it("waits for the action, blocks repeated submissions, then acknowledges completion", async () => {
    vi.useFakeTimers();
    let complete!: (saved: boolean) => void;
    const action = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    render(saveButton(action));
    const button = screen.getByRole("button", { name: "Save All" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(action).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Save All In Progress");
    await act(async () => complete(true));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Save All Complete");
    act(() => vi.advanceTimersByTime(900));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("distinguishes a cancelled save from an error and allows retry", async () => {
    const action = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("Storage Unavailable"))
      .mockResolvedValueOnce(true);
    render(saveButton(action));
    const button = screen.getByRole("button", { name: "Save All" });
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("status").textContent).toBe("");
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("status").textContent).toContain(
      "Storage Unavailable",
    );
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("status").textContent).toBe("Save All Complete");
  });

  it("does not carry a previous document's pending result into the next document", async () => {
    let complete!: (saved: boolean) => void;
    const view = render(
      saveButton(
        () =>
          new Promise<boolean>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save All" }));
    view.rerender(saveButton(async () => true, "project-b"));
    await act(async () => complete(true));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(
      screen
        .getByRole("button", { name: "Save All" })
        .getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("keeps synchronous history actions repeatable during their acknowledgement", () => {
    const undo = vi.fn();
    render(
      <TooltipProvider>
        <ActionFeedbackButton
          icon={Undo2Icon}
          iconOnly
          showSuccessIcon={false}
          label="Undo"
          onAction={undo}
        />
      </TooltipProvider>,
    );
    const button = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(undo).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toBe("Undo Complete");
  });
});
