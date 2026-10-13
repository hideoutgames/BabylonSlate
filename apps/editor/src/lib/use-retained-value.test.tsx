import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { useRetainedValue } from "./use-retained-value";

const NOTHING: string[] = [];

/** A dialog body: builds its list only while open, as the Outliner and Details dialogs do. */
function Body({ open, build }: { open: boolean; build: () => string[] }) {
  const items = useRetainedValue(
    useMemo(() => (open ? build() : null), [build, open]),
    NOTHING,
  );
  return <p data-testid="items">{items.join(",")}</p>;
}

describe("useRetainedValue", () => {
  afterEach(() => {
    cleanup();
  });

  it("builds nothing while closed, keeps the last content through the close, and rebuilds on reopen", () => {
    let version = 1;
    const build = vi.fn(() => [`v${version}`]);
    const { rerender } = render(<Body open={false} build={build} />);
    expect(build).not.toHaveBeenCalled();
    expect(screen.getByTestId("items").textContent).toBe("");

    rerender(<Body open build={build} />);
    expect(screen.getByTestId("items").textContent).toBe("v1");

    // Closing keeps what the dialog showed, without building again.
    rerender(<Body open={false} build={build} />);
    expect(screen.getByTestId("items").textContent).toBe("v1");
    expect(build).toHaveBeenCalledOnce();

    version = 2;
    rerender(<Body open build={() => [`v${version}`]} />);
    expect(screen.getByTestId("items").textContent).toBe("v2");
  });
});
