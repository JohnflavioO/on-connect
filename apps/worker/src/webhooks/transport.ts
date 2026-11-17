import { request } from "node:https";
import { checkWebhookUrl, publicOnlyLookup } from "@on-connect/core";

export { publicOnlyLookup };

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** An HTTP status (any, including 4xx/5xx) or why no response was received. */
export type WebhookResult = { statusCode: number } | { error: string };

export type WebhookSender = (request: WebhookRequest) => Promise<WebhookResult>;

/**
 * POSTs over HTTPS with certificate verification, no redirects (a redirect
 * is reported as its 3xx status, i.e. a failure) and a hard deadline. The
 * response body is never read: only the status matters.
 */
export function createHttpsSender(options: { timeoutMs?: number } = {}): WebhookSender {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return (webhook) =>
    new Promise<WebhookResult>((resolve) => {
      const problem = checkWebhookUrl(webhook.url);
      if (problem) {
        resolve({ error: problem });
        return;
      }
      let settled = false;
      const finish = (result: WebhookResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const outgoing = request(
        webhook.url,
        {
          method: "POST",
          headers: { ...webhook.headers, "content-length": Buffer.byteLength(webhook.body) },
          lookup: publicOnlyLookup,
          signal: AbortSignal.timeout(timeoutMs),
          // One connection per delivery: a pooled socket would skip the lookup.
          agent: false,
        },
        (response) => {
          finish({ statusCode: response.statusCode ?? 0 });
          response.destroy();
        },
      );
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        const code = error.name === "AbortError" || error.name === "TimeoutError"
          ? "timeout"
          : error.code ?? "request_failed";
        finish({ error: code });
      });
      outgoing.end(webhook.body);
    });
}
