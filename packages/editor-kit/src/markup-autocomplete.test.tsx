import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  applyMarkupSuggestion,
  MarkupAutocompleteTextarea,
  markupAutocompleteAt,
} from "./markup-autocomplete";

function idsAt(value: string, caret = value.length): string[] {
  return (markupAutocompleteAt(value, caret)?.items ?? []).map((item) => item.id);
}

describe("markupAutocompleteAt", () => {
  it("suggests tags after an open bracket", () => {
    expect(idsAt("[")).toEqual(
      expect.arrayContaining([
        "tag:b",
        "tag:i",
        "tag:u",
        "tag:color",
        "tag:size",
        "tag:outline",
        "tag:outline-color",
        "tag:img",
        "tag:shake",
        "tag:wave",
        "tag:hover",
        "tag:rotate",
      ]),
    );
  });

  it("filters tags by the partial name", () => {
    expect(idsAt("[co")).toEqual(["tag:color"]);
    expect(idsAt("[out")).toEqual(["tag:outline", "tag:outline-color"]);
  });

  it("suggests named colors and a hex hint after [color=", () => {
    const ids = idsAt("[color=");
    expect(ids).toContain("color:green");
    expect(ids).toContain("color:orange");
    expect(ids).toContain("color-hex");
    expect(idsAt("[color=gr")).toEqual([
      "color:gray",
      "color:grey",
      "color:green",
    ]);
  });

  it("suggests Paste Asset Reference after [img=", () => {
    const session = markupAutocompleteAt("[img=", 5);
    expect(session?.items).toEqual([
      expect.objectContaining({
        id: "img-paste",
        label: "Paste Asset Reference",
      }),
    ]);
  });

  it("suggests size and intensity attributes after a space inside a tag", () => {
    expect(idsAt("[img=guid-1 ")).toEqual(["attr:size"]);
    expect(idsAt("[wave=2 ")).toEqual(["attr:intensity"]);
    expect(idsAt("[wave=2 intensity=")).toEqual([]);
  });

  it("lists every tag when the caret is in plain text", () => {
    const session = markupAutocompleteAt("Hello", 5);
    expect(session?.replaceFrom).toBe(5);
    expect(session?.replaceTo).toBe(5);
    expect(idsAt("Hello", 5)).toEqual(
      expect.arrayContaining([
        "tag:b",
        "tag:i",
        "tag:u",
        "tag:color",
        "tag:size",
        "tag:outline",
        "tag:outline-color",
        "tag:img",
        "tag:shake",
        "tag:wave",
        "tag:hover",
        "tag:rotate",
      ]),
    );
    expect(idsAt("Hello", 5)).toHaveLength(12);
    expect(idsAt("[b]Hi[/b]", 9)).toHaveLength(12);
  });

  it("returns an empty session when the open tag prefix matches nothing", () => {
    const session = markupAutocompleteAt("[zzz", 4);
    expect(session).toEqual({ replaceFrom: 0, replaceTo: 4, items: [] });
  });
});

describe("applyMarkupSuggestion", () => {
  it("inserts a wrapper tag and its close tag", () => {
    const session = markupAutocompleteAt("[", 1);
    expect(session).not.toBeNull();
    expect(applyMarkupSuggestion("[", session!, "tag:b")).toEqual({
      value: "[b][/b]",
      caret: 3,
    });
  });

  it("inserts a wrapper tag at the caret in plain text", () => {
    const session = markupAutocompleteAt("Hi ", 3);
    expect(session).not.toBeNull();
    expect(applyMarkupSuggestion("Hi ", session!, "tag:b")).toEqual({
      value: "Hi [b][/b]",
      caret: 6,
    });
  });

  it("inserts value tags with the caret after = and a close tag", () => {
    const session = markupAutocompleteAt("[co", 3);
    expect(applyMarkupSuggestion("[co", session!, "tag:color")).toEqual({
      value: "[color=][/color]",
      caret: 7,
    });
  });

  it("inserts a void img tag without a close tag", () => {
    const session = markupAutocompleteAt("[", 1);
    expect(applyMarkupSuggestion("[", session!, "tag:img")).toEqual({
      value: "[img=]",
      caret: 5,
    });
  });

  it("completes a named color and closes the wrapper", () => {
    const session = markupAutocompleteAt("[color=", 7);
    expect(applyMarkupSuggestion("[color=", session!, "color:green")).toEqual({
      value: "[color=green][/color]",
      caret: 13,
    });
  });

  it("inserts a hex color hint", () => {
    const session = markupAutocompleteAt("[color=", 7);
    expect(applyMarkupSuggestion("[color=", session!, "color-hex")).toEqual({
      value: "[color=#][/color]",
      caret: 8,
    });
  });

  it("keeps [img=] so the user can paste a guid", () => {
    const session = markupAutocompleteAt("[img=", 5);
    expect(applyMarkupSuggestion("[img=", session!, "img-paste")).toEqual({
      value: "[img=]",
      caret: 5,
    });
  });

  it("inserts attribute completions", () => {
    const session = markupAutocompleteAt("[img=guid-1 ", 12);
    expect(applyMarkupSuggestion("[img=guid-1 ", session!, "attr:size")).toEqual(
      {
        value: "[img=guid-1 size=]",
        caret: 17,
      },
    );
  });
});

describe("MarkupAutocompleteTextarea", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a fixed-height list of every tag when the field is empty", () => {
    render(
      <MarkupAutocompleteTextarea
        value=""
        onChange={() => {}}
        data-testid="markup"
      />,
    );
    const list = screen.getByTestId("markup-suggestions");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.style.height).toBe("256px");
    expect(screen.getByTestId("search-item-tag:b")).toBeTruthy();
    expect(screen.getByTestId("search-item-tag:b").tagName).not.toBe("BUTTON");
    expect(screen.getByTestId("search-item-tag:b").className).toMatch(
      /touch-pan-y/,
    );
  });

  it("lists tags above the textarea when the caret is after [", () => {
    render(
      <MarkupAutocompleteTextarea
        value="["
        onChange={() => {}}
        data-testid="markup"
      />,
    );
    const field = screen.getByTestId("markup") as HTMLTextAreaElement;
    field.setSelectionRange(1, 1);
    fireEvent.select(field);
    expect(screen.getByTestId("markup-suggestions")).toBeTruthy();
    expect(screen.getByTestId("search-item-tag:b")).toBeTruthy();
    expect(screen.getByTestId("search-item-tag:b").getAttribute("role")).toBe(
      "option",
    );
  });

  it("keeps the suggestion panel when the filter matches nothing", () => {
    render(
      <MarkupAutocompleteTextarea
        value="[zzz"
        onChange={() => {}}
        data-testid="markup"
      />,
    );
    const field = screen.getByTestId("markup") as HTMLTextAreaElement;
    field.setSelectionRange(4, 4);
    fireEvent.select(field);
    expect(screen.getByTestId("markup-suggestions")).toBeTruthy();
    expect(screen.queryByTestId("search-item-tag:b")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("inserts wrapper close tags when a suggestion is chosen", () => {
    const onChange = vi.fn();
    render(
      <MarkupAutocompleteTextarea
        value="["
        onChange={onChange}
        data-testid="markup"
      />,
    );
    const field = screen.getByTestId("markup") as HTMLTextAreaElement;
    field.setSelectionRange(1, 1);
    fireEvent.select(field);
    screen.getByTestId("search-item-tag:b").click();
    expect(onChange).toHaveBeenCalledWith("[b][/b]", 3);
  });
});
