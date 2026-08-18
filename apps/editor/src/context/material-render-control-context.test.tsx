import { useEffect } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MaterialRenderControlProvider,
  useMaterialRenderControl,
} from "./material-render-control-context";

function Registration({
  disabled,
  requestRender,
}: {
  disabled: boolean;
  requestRender: () => void;
}) {
  const { register } = useMaterialRenderControl();
  useEffect(
    () => register("material:Rock", { disabled, requestRender }),
    [disabled, register, requestRender],
  );
  return null;
}

function Probe() {
  const { control } = useMaterialRenderControl();
  return (
    <button
      type="button"
      disabled={control?.disabled ?? true}
      onClick={() => control?.requestRender()}
    >
      Render
    </button>
  );
}

describe("MaterialRenderControlProvider", () => {
  afterEach(cleanup);

  it("publishes the active material action and removes it on unmount", async () => {
    const requestRender = vi.fn();
    const view = render(
      <MaterialRenderControlProvider>
        <Registration disabled={false} requestRender={requestRender} />
        <Probe />
      </MaterialRenderControlProvider>,
    );
    const button = screen.getByRole("button", { name: "Render" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(requestRender).toHaveBeenCalledOnce();

    view.rerender(
      <MaterialRenderControlProvider>
        <Probe />
      </MaterialRenderControlProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Render" }).hasAttribute("disabled"),
      ).toBe(true),
    );
  });
});
