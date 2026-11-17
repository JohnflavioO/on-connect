import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request } from "node:https";
import { checkWebhookUrl, isPublicAddress } from "./webhooks.js";

/**
 * Outbound HTTPS to integrator-supplied URLs (webhooks, media to send). The
 * processes doing it sit on the private Docker network with Redis, so a URL
 * must never reach a private address.
 */

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * DNS lookup used for the actual connection: it refuses the request when
 * any resolved address is not public. Checking here, and not before the
 * request, closes the gap where a name resolves to a public address during
 * a check and to a private one when connecting (DNS rebinding).
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const list = addresses;
    const first = list[0];
    if (!first || list.some((entry) => !isPublicAddress(entry.address))) {
      callback(Object.assign(new Error("Destination is not a public address"), { code: "EBLOCKED" }), "");
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, first.address, first.family);
  });
}

export type FetchedBytes =
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; error: string };

/**
 * GETs a public HTTPS URL into memory: certificate verified, no redirects,
 * a hard deadline and a size cap (checked on the declared length and while
 * reading). Errors are short codes, never the URL.
 */
export function fetchPublicBytes(
  url: string,
  options: { maxBytes: number; timeoutMs?: number },
): Promise<FetchedBytes> {
  return new Promise((resolve) => {
    const problem = checkWebhookUrl(url);
    if (problem) {
      resolve({ ok: false, error: problem });
      return;
    }
    let settled = false;
    const finish = (result: FetchedBytes): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const outgoing = request(
      url,
      {
        method: "GET",
        lookup: publicOnlyLookup,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          finish({ ok: false, error: `http_${status}` });
          return;
        }
        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared > options.maxBytes) {
          response.destroy();
          finish({ ok: false, error: "too_large" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            finish({ ok: false, error: "too_large" });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish({
            ok: true,
            bytes: Buffer.concat(chunks),
            contentType: response.headers["content-type"]?.split(";")[0]?.trim() ?? null,
          });
        });
        response.on("error", () => {
          finish({ ok: false, error: "read_failed" });
        });
      },
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.name === "AbortError" || error.name === "TimeoutError"
        ? "timeout"
        : error.code ?? "request_failed";
      finish({ ok: false, error: code });
    });
    outgoing.end();
  });
}
