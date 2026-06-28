import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

/**
 * Minimal logger interface — the shared contract typed against by domain and
 * transport seams. Keeps the injection surface small and enables recording
 * fakes in tests without coupling to pino internals.
 */
export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  fatal(obj: Record<string, unknown>, msg: string): void;
  fatal(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Root pino logger.
 *
 * NODE_ENV === "development"  → pino-pretty transport (tsx dev path only;
 *                               running from dist/server.cjs under this value
 *                               is explicitly unsupported — worker.js cannot
 *                               resolve inside the single-file bundle).
 * everything else (incl. "test", production, undefined) → transport-free,
 *                               fd1, sync:true so the final line lands before
 *                               exit(1) on crash.
 *
 * CRITICAL: gate is `=== "development"`, NOT `!== "production"`.
 * vitest sets NODE_ENV="test"; the wrong gate would spawn thread-stream
 * workers in tests and break the suite.
 */
export const logger: Logger =
  process.env.NODE_ENV === "development"
    ? pino({ level, transport: { target: "pino-pretty" } })
    : pino({ level }, pino.destination({ dest: 1, sync: true }));
