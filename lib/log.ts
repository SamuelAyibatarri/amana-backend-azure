/**
 * Structured JSON logger (paystack-webhook-handler style: one shape,
 * leveled, never logs raw objects).
 */
export function log(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Phone masking for logs: last 4 digits only. Phones are PII — never
 * log `from`/`to`/`phone` raw. Message text is never logged either;
 * log parsed fields (intent/amount/currency) instead.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "…????";
}
