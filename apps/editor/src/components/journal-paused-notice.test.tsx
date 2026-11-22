import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStatusBar } from "./editor-status-bar";
import { JournalPausedNotice } from "./journal-paused-notice";

const state = vi.hoisted(() => ({ journalPaused: false, phone: false }));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  journalPaused: state.journalPaused,
})));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ errorCount: 0 }) }));
vi.mock("../shell/use-platform-layout", () => ({ usePhoneLayout: () => state.phone }));
vi.mock("../lib/build-identity", () => ({ getBuildLabel: () => "test" }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.journalPaused = false;
  state.phone = false;
});

function Editor() {
  return (
    <>
      <EditorStatusBar />
      <JournalPausedNotice />
    </>
  );
}

describe("JournalPausedNotice", () => {
  it.each([["the phone layout", true], ["the desktop layout", false]])("is raised when journaling pauses on %s", (_layout, phone) => {
    state.phone = phone;
    state.journalPaused = true;
    render(<Editor />);
    expect(screen.getByTestId("journal-paused-notice").textContent).toMatch(/Crash Recovery Paused — Use Save All/);
    // Phones hide the status bar, so the notice is the only place that says it.
    expect(screen.queryByTestId("editor-status-bar")).toBe(phone ? null : screen.getByTestId("editor-status-bar"));
  });

  it("shows once per pause: Dismiss or a few seconds hide it until journaling pauses again", () => {
    vi.useFakeTimers();
    const { rerender } = render(<JournalPausedNotice />);
    expect(screen.queryByTestId("journal-paused-notice")).toBeNull();
    state.journalPaused = true;
    rerender(<JournalPausedNotice />);
    fireEvent.click(screen.getByTestId("journal-paused-notice-dismiss"));
    rerender(<JournalPausedNotice />);
    expect(screen.queryByTestId("journal-paused-notice")).toBeNull();

    state.journalPaused = false;
    rerender(<JournalPausedNotice />);
    state.journalPaused = true;
    rerender(<JournalPausedNotice />);
    expect(screen.getByTestId("journal-paused-notice")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByTestId("journal-paused-notice")).toBeNull();
  });
});
