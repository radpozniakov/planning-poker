import type { Logger } from "../logger";

/**
 * One recorded log call. `obj` includes any bindings merged in from child()
 * loggers, mirroring pino's real child-binding behavior so the fake is a
 * faithful substitute for the production logger.
 */
export interface LogCall {
  level: "info" | "warn" | "error" | "fatal";
  obj?: Record<string, unknown>;
  msg: string;
}

/** A recording Logger plus the flat array of calls it captured. */
export type RecordingLogger = Logger & { calls: LogCall[] };

/**
 * Build a binding-aware recording logger that captures calls for assertion
 * without touching stdout. Child loggers merge their parent bindings into
 * every recorded call (like pino), and all children push into the SAME
 * `calls` array, so a single fake observes the whole correlation timeline.
 *
 * Pass a shared `calls` array to observe it from the call site, or read it
 * back via the returned logger's `.calls`.
 */
export function makeRecordingLogger(
  calls: LogCall[] = [],
  bindings: Record<string, unknown> = {},
): RecordingLogger {
  const record =
    (level: LogCall["level"]) =>
    (objOrMsg: Record<string, unknown> | string, msg?: string): void => {
      if (typeof objOrMsg === "string") {
        // No per-call obj: still surface the bound correlation fields if any.
        calls.push(
          Object.keys(bindings).length > 0
            ? { level, obj: { ...bindings }, msg: objOrMsg }
            : { level, msg: objOrMsg },
        );
      } else {
        calls.push({
          level,
          obj: { ...bindings, ...objOrMsg },
          msg: msg ?? "",
        });
      }
    };

  const log: RecordingLogger = {
    calls,
    info: record("info") as Logger["info"],
    warn: record("warn") as Logger["warn"],
    error: record("error") as Logger["error"],
    fatal: record("fatal") as Logger["fatal"],
    child(more: Record<string, unknown>): Logger {
      return makeRecordingLogger(calls, { ...bindings, ...more });
    },
  };
  return log;
}

/** Group captured calls by level — convenience for tests that key on level. */
export function byLevel(calls: LogCall[]): Record<LogCall["level"], LogCall[]> {
  const grouped: Record<LogCall["level"], LogCall[]> = {
    info: [],
    warn: [],
    error: [],
    fatal: [],
  };
  for (const c of calls) grouped[c.level].push(c);
  return grouped;
}
