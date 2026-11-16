import { createLogger, type SystemPingJob } from "@on-connect/core";
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { createSystemProcessor } from "../src/processors/system.js";

const logger = createLogger({ level: "silent", service: "test" });

function job(name: string, requestedAt: string): Job<SystemPingJob> {
  // Only the fields the processor reads; a real Job needs a live queue.
  return { id: "1", name, data: { requestedAt } } as unknown as Job<SystemPingJob>;
}

describe("system processor", () => {
  it("measures ping latency", async () => {
    const process = createSystemProcessor(logger);
    const result = await process(job("ping", new Date(Date.now() - 50).toISOString()));
    expect(result.latencyMs).toBeGreaterThanOrEqual(50);
    expect(result.latencyMs).toBeLessThan(5_000);
  });

  it("fails on an unknown job name", async () => {
    const process = createSystemProcessor(logger);
    await expect(process(job("mystery", new Date().toISOString()))).rejects.toThrow(
      "Unknown system job: mystery",
    );
  });
});
