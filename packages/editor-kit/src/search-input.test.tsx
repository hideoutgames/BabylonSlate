import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SearchInput } from "./search-input";

afterEach(() => {
  cleanup();
});

describe("SearchInput", () => {
  it("hides the clear button when the value is empty", () => {
    const { queryByTestId } = render(
      <SearchInput value="" onChange={() => {}} data-testid="search" />,
    );
    expect(queryByTestId("search-clear")).toBeNull();
  });

  it("clears the value when the clear button is pressed", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <SearchInput value="hero" onChange={onChange} data-testid="search" />,
    );
    fireEvent.click(getByTestId("search-clear"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
