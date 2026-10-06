import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { log, maskPhone } from "../lib/log.ts";

export interface IncomingMessage {
  from: string; // digits-only phone / remoteJid user part
  text: string;
  pushName?: string;
}

type OnMessage = (msg: IncomingMessage) => void;

// Auth state lives in ./sessions (creds.json + keys, kilobytes).
// Survives restarts and reboots; only a disk wipe forces a re-pair.
const AUTH_DIR = "./sessions";

let sock: WASocket | null = null;
let ready = false;
let dead = false; // logged out — reconnecting would only hammer
let failures = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const BACKOFF_MS = [3_000, 6_000, 12_000, 30_000];
const MAX_FAILURES = 10;

function jid(to: string): string {
  return `${to.replace(/\D/g, "")}@s.whatsapp.net`;
}

/** Last-seen full JID per sender digits. Replies route through it. */
const peerJid = new Map<string, string>();

/** Routable JID for a digits recipient: seen form, else PN default. */
function routeJid(to: string): string {
  const key = to.replace(/\D/g, "");
  return peerJid.get(key) ?? jid(key);
}

/**
 * Resolve a sender JID to digits. Ladder:
 * 1. `remoteJidAlt` — the real PN carried alongside the LID (no mapping
 *    store, no history dependency);
 * 2. `getPNForLID` signal mapping;
 * 3. raw user part (routable via the peerJid record).
 */
async function resolveSender(
  ws: WASocket,
  remoteJid: string,
  remoteJidAlt?: string,
): Promise<string> {
  const user = remoteJid.split("@")[0] ?? "";
  if (!remoteJid.endsWith("@lid")) return user.replace(/\D/g, "");
  const altUser = (remoteJidAlt ?? "").split("@")[0] ?? "";
  if (remoteJidAlt?.endsWith("@s.whatsapp.net") && /^\d+$/.test(altUser)) {
    return altUser.replace(/\D/g, "");
  }
  try {
    const pn = await ws.signalRepository.lidMapping.getPNForLID(user);
    if (pn) return pn.replace(/\D/g, "");
  } catch {
    // Mapping unavailable — fall through to the raw user part.
  }
  return user.replace(/\D/g, "");
}

function scheduleReconnect(start: () => void): void {
  if (dead) return;
  if (failures >= MAX_FAILURES) {
    log(
      "error",
      "Too many consecutive connection failures; giving up. Restart to retry.",
      { failures },
    );
    return;
  }
  const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
  log("warn", "WhatsApp reconnect scheduled", { inMs: delay, failures });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(start, delay);
}

/**
 * Start the Baileys socket. Events arrive in-process (no webhooks).
 * QR prints in the terminal on first boot; scan with the bot line.
 */
export async function startWhatsApp(onMessage: OnMessage): Promise<void> {
  if (sock || dead) return;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version: [number, number, number] | undefined;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch {
    log("warn", "Baileys version fetch failed; using bundled defaults");
  }

  const start = async (): Promise<void> => {
    if (dead) return;
    const ws = makeWASocket({
      auth: state,
      version,
      // Default browser string (stock desktop Chrome) — custom identifiers
      // only make the session more fingerprintable.
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Bounded sync: allowed while connecting (builds LID mappings at
      // boot), denied once online (no ongoing history downloads).
      // `messages.upsert` still only processes live `notify` events,
      // so synced history can never trigger replies.
      shouldSyncHistoryMessage: () => !ready,
      getMessage: async () => undefined,
      generateHighQualityLinkPreview: false,
    });
    sock = ws;

    ws.ev.on("creds.update", saveCreds);

    ws.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        qrcode.generate(qr, { small: true });
        log("info", "Scan the QR above with the bot line");
      }
      if (connection === "open") {
        ready = true;
        failures = 0;
        log("info", "WhatsApp connected");
      }
      if (connection === "close") {
        ready = false;
        sock = null;
        const code = (lastDisconnect?.error as Boom | undefined)?.output
          ?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Keys rejected server-side. Reconnecting hammers a dead
          // session into a permanent logout — stop, surface, re-pair.
          dead = true;
          log(
            "error",
            "WhatsApp logged out (401). Delete ./sessions and restart to re-pair with a fresh QR.",
          );
          return;
        }
        failures += 1;
        scheduleReconnect(start);
      }
    });

    ws.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      void (async () => {
        for (const m of messages) {
          const remoteJid = m.key.remoteJid ?? "";
          const isUserChat =
            remoteJid.endsWith("@s.whatsapp.net") ||
            remoteJid.endsWith("@lid");
          if (m.key.fromMe || !isUserChat) continue;
          const text =
            m.message?.conversation ??
            m.message?.extendedTextMessage?.text ??
            "";
          if (!text.trim()) continue;
          const from = await resolveSender(
            ws,
            remoteJid,
            m.key.remoteJidAlt,
          );
          // Remember the routable JID per sender: replies must go back
          // through the seen address form (@lid stays @lid).
          peerJid.set(from, remoteJid);
          // Blue ticks: mark read on receipt (human opens the chat first,
          // then types). Best-effort — never blocks dispatch.
          void markRead(m.key.remoteJid ?? remoteJid, m.key.id ?? "");
          onMessage({
            from,
            text: text.trim(),
            pushName: m.pushName ?? undefined,
          });
        }
      })().catch((err) =>
        log("error", "Inbound message dispatch failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  };

  await start();
}

// Typing time scales with reply length like a human thumb: ~0.6s base,
// +6ms per character, capped at 1.6s. Early presence during inference
// already covered the thinking time.
function typingTimeMs(text: string): number {
  return Math.min(1600, Math.max(700, 600 + text.length * 6));
}

/**
 * Read receipt (blue ticks) for one inbound message. Fire-and-forget:
 * never throws, skipped when offline. 1:1 chats only — group keys
 * need participant routing and group messages are ignored anyway.
 */
export async function markRead(
  remoteJid: string,
  id: string,
): Promise<void> {
  if (!sock || !ready || !remoteJid || !id) return;
  try {
    await sock.readMessages([{ remoteJid, id }]);
  } catch (err) {
    log("warn", "Baileys read receipt error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function sendPresence(
  to: string,
  presence: "composing" | "paused",
  _delayMs: number,
): Promise<void> {
  if (!sock || !ready) return;
  try {
    await sock.sendPresenceUpdate(presence, routeJid(to));
  } catch (err) {
    log("warn", "Baileys presence error", {
      to: maskPhone(to),
      presence,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Human-mimicry send: typing presence -> short pause -> message.
 * Never throws — socket downtime must not crash the caller.
 */
export async function replyText(to: string, text: string): Promise<boolean> {
  if (!sock || !ready) {
    log("warn", "WhatsApp not connected; message logged, not sent", { to: maskPhone(to) });
    return false;
  }
  try {
    const thinkMs = typingTimeMs(text);
    await sendPresence(to, "composing", thinkMs);
    await new Promise((resolve) =>
      setTimeout(resolve, thinkMs + Math.random() * 250),
    );
    await sock.sendMessage(routeJid(to), { text });
    void sendPresence(to, "paused", 500);
    return true;
  } catch (err) {
    log("error", "Baileys send error", {
      to: maskPhone(to),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Image + caption send (receipts). Same routing/presence as text.
 * Never throws — returns false when undeliverable.
 */
export async function sendImage(
  to: string,
  png: Uint8Array,
  caption: string,
): Promise<boolean> {
  if (!sock || !ready) {
    log("warn", "WhatsApp not connected; image logged, not sent", { to: maskPhone(to) });
    return false;
  }
  try {
    const thinkMs = typingTimeMs(caption);
    await sendPresence(to, "composing", thinkMs);
    await new Promise((resolve) =>
      setTimeout(resolve, thinkMs + Math.random() * 250),
    );
    await sock.sendMessage(routeJid(to), {
      image: Buffer.from(png),
      caption,
    });
    void sendPresence(to, "paused", 500);
    return true;
  } catch (err) {
    log("error", "Baileys image send error", {
      to: maskPhone(to),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Check which numbers exist on WhatsApp (pre-send validation).
 * Returns a map number->exists, or null when the check itself fails.
 */
export async function checkWhatsAppNumbers(
  numbers: string[],
): Promise<Map<string, boolean> | null> {
  if (!sock || !ready || numbers.length === 0) return null;
  try {
    const res = await sock.onWhatsApp(
      ...numbers.map((n) => n.replace(/\D/g, "")),
    );
    const out = new Map<string, boolean>();
    for (const row of res ?? []) {
      const num = (row.jid ?? "").split("@")[0] ?? "";
      if (num) out.set(num.replace(/\D/g, ""), row.exists === true);
    }
    return out;
  } catch (err) {
    log("warn", "Baileys number check error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
