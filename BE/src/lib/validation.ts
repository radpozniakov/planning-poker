import type { ZodType } from "zod";

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Thin `safeParse` wrapper (ADR-002). Every inbound (client -> server) message is
 * validated here; on failure handlers reply with an `errorEvent` rather than throwing.
 */
export function validate<T>(schema: ZodType<T>, raw: unknown): ValidationResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const message =
    result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ") || "invalid payload";
  return { ok: false, message };
}
