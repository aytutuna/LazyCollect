import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { UploadQueue, type Job } from "./queue";

const file = { blob: new Blob(["%PDF-1.7"]), name: "passport.pdf", jpeg: false };

describe("upload queue", () => {
  it("keeps a file when the account is paused and sends it once the link takes files again", async () => {
    const send = vi.fn().mockRejectedValueOnce(new ApiError(402, "paused")).mockResolvedValue(undefined);
    const done: Job[] = [];
    const queue = new UploadQueue("eu_token", send, (job) => done.push(job));
    await queue.restore();
    await queue.add("item-1", [file]);

    await vi.waitFor(() => expect(queue.jobs[0].state).toBe("paused"));
    expect(queue.jobs).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(done).toHaveLength(0);

    queue.resume();
    await vi.waitFor(() => expect(done).toHaveLength(1));
    expect(queue.jobs).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not try a paused file again until it is resumed", async () => {
    const send = vi.fn().mockRejectedValue(new ApiError(402, "paused"));
    const queue = new UploadQueue("eu_token", send, () => {});
    await queue.restore();
    await queue.add("item-1", [file, { ...file, name: "visa.pdf" }]);
    await vi.waitFor(() => expect(queue.jobs.map((j) => j.state)).toEqual(["paused", "paused"]));
    expect(send).toHaveBeenCalledTimes(2);
    queue.online();
    // long enough for a wrong resend to reach the sender
    await new Promise((r) => setTimeout(r, 50));
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.jobs.map((j) => j.state)).toEqual(["paused", "paused"]);
  });
});
