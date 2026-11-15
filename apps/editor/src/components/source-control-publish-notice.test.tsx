import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceControlPublishNotice } from "./source-control-publish-notice";

const state = vi.hoisted(() => ({
  notice: null as { message: string } | null,
  dismiss: vi.fn(),
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    publishNotice: state.notice,
    dismissPublishNotice: state.dismiss,
  })),
);

afterEach(() => {
  cleanup();
  state.notice = null;
  state.dismiss.mockClear();
});

describe("Source Control publish notice", () => {
  it("says why a Remote New Project stayed Local and where Publish is, until dismissed", () => {
    state.notice = { message: "github.com could not be reached." };
    render(<SourceControlPublishNotice />);
    const notice = screen.getByTestId("source-control-publish-notice");
    expect(notice.textContent).toContain("Created As A Local Project");
    expect(notice.textContent).toContain("github.com could not be reached. To put it on a Git host, choose Publish Project in Project Settings > Source Control.");
    fireEvent.click(screen.getByTestId("source-control-publish-notice-dismiss"));
    expect(state.dismiss).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a project created as asked", () => {
    render(<SourceControlPublishNotice />);
    expect(screen.queryByTestId("source-control-publish-notice")).toBeNull();
  });
});
