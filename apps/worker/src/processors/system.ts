import type { Logger, SystemPingJob } from "@on-connect/core";
import type { Job } from "bullmq";

/**
 * Handles the `system` queue. Its only job today is `ping`, enqueued by the
 * worker itself at boot to prove the Redis -> BullMQ -> processor round trip.
 */
export function createSystemProcessor(logger: Logger) {
  return async (job: Job<SystemPingJob>): Promise<{ latencyMs: number }> => {
    if (job.name !== "ping") {
      // Unknown job names are a deploy mismatch, not a transient failure.
      throw new Error(`Unknown system job: ${job.name}`);
    }
    const latencyMs = Date.now() - Date.parse(job.data.requestedAt);
    logger.info({ jobId: job.id, latencyMs }, "system ping processed");
    return { latencyMs };
  };
}
