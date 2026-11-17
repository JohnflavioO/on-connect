import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions, redactUrl } from "../src/logger.js";

describe("redactUrl", () => {
  it("removes the token of a media link and leaves other paths alone", () => {
    expect(redactUrl("/media/eyJwIjoiMjAyNiJ9.c2lnbmF0dXJl")).toBe("/media/[REDACTED]");
    expect(redactUrl("/media/abc.def?x=1")).toBe("/media/[REDACTED]?x=1");
    expect(redactUrl("/v1/connections/1/messages")).toBe("/v1/connections/1/messages");
  });
});

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, stream };
}

describe("logger redaction", () => {
  it("removes tokens and secrets from logged objects", () => {
    const { lines, stream } = capture();
    const logger = pino(loggerOptions({ level: "info", service: "test" }), stream);

    logger.info(
      {
        access_token: "EAAG-top-level",
        credentials: { accessToken: "EAAG-nested", appSecret: "shh" },
        req: { headers: { authorization: "Bearer abc123", "x-hub-signature-256": "sha256=dead" } },
        phoneNumberId: "1055",
      },
      "meta call",
    );

    const output = lines.join("");
    for (const leaked of ["EAAG-top-level", "EAAG-nested", "shh", "abc123", "sha256=dead"]) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("1055");
    expect(output).toContain('"service":"test"');
  });
});
