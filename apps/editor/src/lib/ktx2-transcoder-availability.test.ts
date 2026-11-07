import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh page: the found-transcoder memo lives for the module's lifetime. */
async function freshPage() {
  vi.resetModules();
  return (await import("./ktx2-transcoder-availability")).applyEditorKtx2TranscoderAvailability;
}

describe("editor KTX2 transcoder availability", () => {
  beforeEach(() => { vi.resetModules(); });

  it("probes once per page after the transcoder is found and applies the answer at every open", async () => {
    const applyAvailability = await freshPage();
    const probe = vi.fn(async () => true);
    const apply = vi.fn(async () => {});
    await applyAvailability(probe, apply);
    await applyAvailability(probe, apply);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(expect.stringMatching(/ktx2\/$/));
    expect(apply.mock.calls).toEqual([[true], [true]]);
  });

  it("asks again at the next open after a probe found the transcoder missing or failed", async () => {
    const applyAvailability = await freshPage();
    const probe = vi.fn<(base: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(true);
    const apply = vi.fn(async () => {});
    await applyAvailability(probe, apply);
    await expect(applyAvailability(probe, apply)).rejects.toThrow("offline");
    await applyAvailability(probe, apply);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls).toEqual([[false], [true]]);
  });

  it("applies a shared probe's answer once, for the latest open", async () => {
    const applyAvailability = await freshPage();
    let answerFirst!: (available: boolean) => void;
    const probe = vi.fn<(base: string) => Promise<boolean>>()
      .mockReturnValueOnce(new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce(true);
    const apply = vi.fn(async () => {});
    const first = applyAvailability(probe, apply);
    // The second open shares the first open's probe while it is out.
    const second = applyAvailability(probe, apply);
    answerFirst(false);
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledOnce();
    expect(apply.mock.calls).toEqual([[false]]);
  });
});
