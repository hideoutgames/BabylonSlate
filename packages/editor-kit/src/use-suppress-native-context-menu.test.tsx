import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSuppressNativeContextMenu } from "./use-suppress-native-context-menu";
import { SelectableText } from "./selectable-text";

function Host({ enabled = true }: { enabled?: boolean }) {
  useSuppressNativeContextMenu(enabled);
  return (
    <div>
      <div data-testid="chrome">chrome</div>
      <input data-testid="field" />
      <SelectableText>
        <span data-testid="selectable">copy me</span>
      </SelectableText>
    </div>
  );
}

function contextMenuOn(el: Element): boolean {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("useSuppressNativeContextMenu", () => {
  afterEach(cleanup);

  it("suppresses the native menu on ordinary chrome", () => {
    const { getByTestId } = render(<Host />);
    expect(contextMenuOn(getByTestId("chrome"))).toBe(true);
  });

  it("leaves the native menu on inputs so paste still works", () => {
    const { getByTestId } = render(<Host />);
    expect(contextMenuOn(getByTestId("field"))).toBe(false);
  });

  it("leaves the native menu inside opted-in selectable text", () => {
    const { getByTestId } = render(<Host />);
    expect(contextMenuOn(getByTestId("selectable"))).toBe(false);
  });

  it("does nothing when disabled", () => {
    const { getByTestId } = render(<Host enabled={false} />);
    expect(contextMenuOn(getByTestId("chrome"))).toBe(false);
  });

  it("removes the listener on unmount", () => {
    const { getByTestId, unmount } = render(<Host />);
    const chrome = getByTestId("chrome");
    document.body.appendChild(chrome);
    unmount();
    expect(contextMenuOn(chrome)).toBe(false);
  });
});
