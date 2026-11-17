import type { Logger } from "pino";

type ConsoleMethod = "log" | "info" | "debug" | "trace" | "warn" | "error";

/**
 * libsignal (used by Baileys) writes Signal session objects straight to the
 * console, e.g. "Closing session: SessionEntry { ... privKey, rootKey ... }".
 * Those are live encryption keys and must never reach container logs.
 *
 * Every console method is replaced: only string arguments are kept (objects,
 * Buffers and errors are dropped), the text is cut short, and it goes to the
 * structured logger, which applies the usual redaction.
 */
export function guardConsole(logger: Logger, target: Console = console): void {
  const forward = (level: "debug" | "warn") =>
    (...args: unknown[]): void => {
      const text = args
        .filter((arg): arg is string => typeof arg === "string")
        .join(" ")
        .slice(0, 200);
      const dropped = args.length - args.filter((arg) => typeof arg === "string").length;
      if (text || dropped) logger[level]({ console: true, dropped }, text || "(non-text console output dropped)");
    };

  const quiet: ConsoleMethod[] = ["log", "info", "debug", "trace"];
  for (const method of quiet) target[method] = forward("debug");
  target.warn = forward("warn");
  target.error = forward("warn");
}
