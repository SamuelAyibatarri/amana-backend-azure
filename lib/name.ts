import { GoogleGenAI } from "@google/genai";
import { cleanName } from "./greet.ts";
import { getConvo } from "../sessions-manager/conversation.ts";
import { log } from "./log.ts";

/**
 * Display-name resolution, two tiers:
 * - Tier 1 (deterministic): clean alpha names resolve with no model call.
 * - Tier 2 (Gemini): ambiguous pushNames (emoji, nicknames, mixed text)
 *   get one extraction attempt; output is validated as strictly as
 *   intent fields. Unusable → "User" fallback when a pushName existed.
 *
 * Resolved once per pushName value, cached on the convo.
 */

const MODEL = process.env.GENAI_MODEL ?? "gemini-2.5-flash-lite";

/** Tier 1: obvious resolutions without the model. */
function localResolve(pushName: string | undefined): {
  done: boolean;
  name: string | null;
} {
  if (!pushName || !pushName.trim()) return { done: true, name: null };
  const cleaned = cleanName(pushName);
  // Clean alpha (maybe multi-word) resolves immediately.
  if (cleaned && /^[A-Za-z'’\s-]+$/.test(pushName.trim())) {
    return { done: true, name: cleaned };
  }
  // Digits-only: no name, no model.
  if (/^[\d\s+()-]+$/.test(pushName.trim())) {
    return { done: true, name: null };
  }
  return { done: false, name: null };
}

async function modelResolve(pushName: string): Promise<string | null> {
  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model: MODEL,
      contents:
        `This is someone's WhatsApp display name: "${pushName}". ` +
        `Reply with ONLY a usable first name to address them (e.g. "Big Sam" → Sam, "Dad's phone" → nothing usable). ` +
        `If no usable name exists, reply exactly EMPTY. No punctuation, no explanation.`,
      config: { responseMimeType: "text/plain" },
    });
    const raw = (res.text ?? "").trim();
    if (!raw || /^empty$/i.test(raw)) return null;
    return cleanName(raw);
  } catch (err) {
    log("warn", "Display-name model call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ResolvedName {
  /** Null = no usable name (bare greeting). */
  name: string | null;
  /** True when the fallback "User" applies (pushName existed, unusable). */
  useUserFallback: boolean;
  /** "local" | "model" | "cache" | "kyc" — observability. */
  via: "local" | "model" | "cache" | "kyc";
}

/**
 * Resolve a display name for a phone, cached per pushName value.
 * Order: KYC real name (D1) → pushName tiers. Never throws — worst
 * case is a bare greeting.
 */
export async function resolveDisplayName(
  phone: string,
  pushName: string | undefined,
  d1Name?: string,
): Promise<ResolvedName> {
  const kyc = cleanName(d1Name);
  if (kyc) return { name: kyc, useUserFallback: false, via: "kyc" };
  const convo = getConvo(phone);
  if (convo.pushNameSeen === pushName && convo.displayName !== undefined) {
    return {
      name: convo.displayName,
      useUserFallback:
        convo.displayName === null && !!pushName?.trim(),
      via: "cache",
    };
  }
  const local = localResolve(pushName);
  let name: string | null;
  let via: "local" | "model";
  if (local.done) {
    name = local.name;
    via = "local";
  } else {
    name = await modelResolve(pushName ?? "");
    via = "model";
  }
  convo.pushNameSeen = pushName;
  convo.displayName = name;
  return {
    name,
    useUserFallback: name === null && !!pushName?.trim(),
    via,
  };
}

/** Greeting name: resolved name, "User" fallback, or null (bare). */
export function greetingName(r: ResolvedName): string | null {
  return r.name ?? (r.useUserFallback ? "User" : null);
}
