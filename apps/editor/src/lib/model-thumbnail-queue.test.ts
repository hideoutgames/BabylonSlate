import { describe, expect, it } from "vitest";
import {
  enqueueModelThumbnailJobs,
  subscribeModelThumbnailJobs,
} from "./model-thumbnail-queue";

describe("model thumbnail queue", () => {
  it("delivers jobs to subscribers without blocking the caller", () => {
    const received: Array<{ guid: string }>[] = [];
    const stop = subscribeModelThumbnailJobs((jobs) => {
      received.push(jobs.map((job) => ({ guid: job.guid })));
    });
    enqueueModelThumbnailJobs([
      {
        guid: "model-1",
        path: "assets/hero.babasset",
        payload: { materialSlots: [], clipNames: [] },
      },
    ]);
    expect(received).toEqual([[{ guid: "model-1" }]]);
    stop();
    enqueueModelThumbnailJobs([
      {
        guid: "model-2",
        path: "assets/rock.babasset",
        payload: { materialSlots: [], clipNames: [] },
      },
    ]);
    expect(received).toHaveLength(1);
  });
});
