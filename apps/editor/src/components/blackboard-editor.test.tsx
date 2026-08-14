import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultBlackboard } from "@babylonslate/behaviour-tree";
import { BlackboardEditor } from "./blackboard-editor";

afterEach(() => {
  cleanup();
});

describe("BlackboardEditor", () => {
  it("adds a typed key", () => {
    const onChange = vi.fn();
    render(
      <BlackboardEditor
        payload={createDefaultBlackboard("AI") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("blackboard-key-alert")).toBeTruthy();
    fireEvent.click(screen.getByTestId("blackboard-add-key"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      keys: Array<{ name: string }>;
    };
    expect(next.keys.some((key) => key.name === "key")).toBe(true);
  });
});
