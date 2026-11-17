import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { guardConsole } from "../src/console-guard.js";

function capture() {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
  const target: Console = { ...console };
  guardConsole(logger, target);
  return { lines, target };
}

describe("guardConsole", () => {
  it("never forwards objects such as libsignal session entries", () => {
    const { lines, target } = capture();
    const secret = Buffer.from("super-secret-private-key-material");
    target.log("Closing session:", {
      currentRatchet: { ephemeralKeyPair: { privKey: secret }, rootKey: secret },
    });
    target.info({ privKey: secret });
    const output = lines.join("\n");
    expect(output).toContain("Closing session:");
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain(secret.toString("base64"));
    expect(output).not.toContain("privKey");
  });

  it("routes every console method through the logger", () => {
    const { lines, target } = capture();
    target.warn("w");
    target.error("e", new Error("with stack"));
    target.debug("d");
    target.trace("t");
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).not.toContain("with stack");
  });

  it("caps long text", () => {
    const { lines, target } = capture();
    target.log("x".repeat(1_000));
    const message = (JSON.parse(lines[0] ?? "{}") as { msg: string }).msg;
    expect(message.length).toBe(200);
  });
});
