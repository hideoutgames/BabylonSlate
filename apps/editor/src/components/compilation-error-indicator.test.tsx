import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CompilationErrorIndicator } from "./compilation-error-indicator";

afterEach(() => {
  cleanup();
});

describe("CompilationErrorIndicator", () => {
  it("renders nothing when there are no blocking errors", () => {
    const { queryByTestId } = render(
      <CompilationErrorIndicator errorCount={0} onOpenResults={() => {}} />,
    );

    expect(queryByTestId("compilation-error")).toBeNull();
  });

  it("shows Compilation Error when there are blocking errors", () => {
    const { getByTestId } = render(
      <CompilationErrorIndicator errorCount={2} onOpenResults={() => {}} />,
    );

    expect(getByTestId("compilation-error").textContent).toBe(
      "Compilation Error",
    );
  });

  it("opens Compiler Results when tapped", () => {
    const onOpenResults = vi.fn();
    const { getByTestId } = render(
      <CompilationErrorIndicator errorCount={1} onOpenResults={onOpenResults} />,
    );

    fireEvent.click(getByTestId("compilation-error"));
    expect(onOpenResults).toHaveBeenCalledTimes(1);
  });
});
