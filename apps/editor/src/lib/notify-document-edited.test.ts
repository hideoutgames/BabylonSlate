import { describe, expect, it, vi } from "vitest";
import { notifyDocumentEdited } from "./notify-document-edited";

describe("notifyDocumentEdited", () => {
  it("bumps and schedules save before the journal promise resolves", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const journal = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = notifyDocumentEdited({
      scheduleDebouncedSave: () => order.push("save"),
      bump: () => order.push("bump"),
      journal: () => {
        order.push("journal-start");
        return journal;
      },
    });

    expect(order).toEqual(["save", "bump", "journal-start"]);
    release?.();
    await pending;
    expect(order).toEqual(["save", "bump", "journal-start"]);
  });

  it("still bumps when the journal rejects", async () => {
    const bump = vi.fn();
    const error = new Error("journal write failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      notifyDocumentEdited({
        scheduleDebouncedSave: () => {},
        bump,
        journal: async () => {
          throw error;
        },
      }),
    ).resolves.toBeUndefined();

    expect(bump).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
