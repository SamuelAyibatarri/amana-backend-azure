/**
 * Time-aware greetings (Africa/Lagos — users are Nigerian numbers on NGN
 * rails; server runs UTC. Per-user timezone is post-hackathon).
 * Pure functions: no I/O, trivially testable.
 */

export type DaySlot = "night-owl" | "morning" | "afternoon" | "evening" | "late";

const LAGOS_TZ = "Africa/Lagos";

/** Hour (0-23) in Lagos for a given moment. */
export function lagosHour(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LAGOS_TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  return hour === 24 ? 0 : hour;
}

export function slotForHour(hour: number): DaySlot {
  if (hour < 5) return "night-owl";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "late";
}

/**
 * Sanitize a name candidate: first token, letters/apostrophe/hyphen only,
 * capped at 20 chars. Returns null for digits-only or empty input —
 * never greet someone as a phone number.
 */
export function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  if (!first || first.length > 20) return null;
  if (!/^[A-Za-z][A-Za-z'’-]*$/.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Greeting line for a slot. Name is optional — the line stands alone
 * without one. The literal "User" fallback is applied by the caller
 * only when a pushName existed but was unusable.
 */
export function greet(name: string | null, now: Date = new Date()): string {
  const slot = slotForHour(lagosHour(now));
  const who = name ? `, ${name}` : "";
  switch (slot) {
    case "night-owl":
      return `*Hello, night owl${who} 🌙*`;
    case "morning":
      return `*Good morning${who} ☀️*`;
    case "afternoon":
      return `*Good afternoon${who} 🌤️*`;
    case "evening":
      return `*Good evening${who} 🌙*`;
    case "late":
      return `*Up late${who}? 🌙*`;
  }
}
