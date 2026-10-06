import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import QRCode from "qrcode";
import { displayPhone } from "../whatsappbot/intent.ts";
import { formatNum } from "../sessions-manager/transfers.ts";
import { log } from "../lib/log.ts";

/**
 * WhatsApp receipt images (PNG). satori renders JSX-shaped element objects
 * to SVG (no browser, no React dependency); resvg rasterizes.
 * DESIGN.md tokens: Ember Night header, Bone card, Ember Glow accents.
 * Phones are ALWAYS masked (080…4567) — full numbers never render.
 */

const EMBER_NIGHT = "#161009";
const WARM_BONE = "#F6F1E7";
const EMBER_GLOW = "#FC5800";
const ESPRESSO = "#2A2118";
const TAUPE = "#8A7B66";
const SAND_LINE = "#EAD9C2";

const W = 1080;
const H = 1350;

/** 08031234567 from E.164, then masked to 080…4567. */
export function maskPhone(e164: string): string {
  const local = displayPhone(e164);
  return local.length >= 7
    ? `${local.slice(0, 3)}…${local.slice(-3)}`
    : "…";
}

/** First 4 + … + last 4 of a base58 address. */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export type ReceiptData =
  | {
      kind: "credit";
      amount: number;
      currency: string;
      fromPhone: string;
      toPhone: string;
      transferId: string;
      receiptUrl?: string;
      timestamp: string;
    }
  | {
      kind: "onchain";
      amount: number;
      toAddress: string;
      signature: string;
      solscanUrl: string;
      timestamp: string;
      /** Defaults SOL (USDC sends pass "USDC"). */
      unit?: string;
    }
  | {
      kind: "buy";
      amountMinorLabel: string;
      reference: string;
      timestamp: string;
      /** Optional: receipt page URL (QR) for funded buys. */
      receiptUrl?: string;
    };

type El = { type: string; props: Record<string, unknown> };
const el = (
  type: string,
  style: Record<string, string | number>,
  ...children: Array<El | string>
): El => ({ type, props: { style, children: children.length ? children : undefined } });
const text = (
  content: string,
  style: Record<string, string | number>,
): El => ({
  type: "div",
  props: { style, children: content },
});

let logoPromise: Promise<string> | null = null;

/** Logo as a data URL (cached). Falls back to null when unreadable. */
async function loadLogo(): Promise<string | null> {
  if (!logoPromise) {
    logoPromise = (async () => {
      try {
        const svg = await Bun.file("assets/logo.svg").text();
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      } catch {
        return "";
      }
    })();
  }
  const url = await logoPromise;
  return url || null;
}

function brandRow(logo: string | null): El {
  return el(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center" },
    logo
      ? ({ type: "img", props: { src: logo, width: 132, height: 82 } } as unknown as El)
      : el("div", {
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: EMBER_GLOW,
          marginRight: 20,
        }),
    text("AMANA", {
      fontSize: 44,
      fontWeight: 700,
      color: "#FFFFFF",
      letterSpacing: 6,
      marginLeft: logo ? 20 : 0,
    }),
  );
}

let fontsPromise: Promise<
  Array<{ name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }>
> | null = null;

function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      const regular = await Bun.file("assets/fonts/Inter-Regular.woff").arrayBuffer();
      const bold = await Bun.file("assets/fonts/Inter-Bold.woff").arrayBuffer();
      // DejaVu fallback: Inter's latin subset lacks ₦ → ≈ and similar
      // glyphs. Satori falls through per-glyph, so receipts stay Inter
      // everywhere Inter reaches and degrade invisibly where it doesn't.
      const dejavu = await Bun.file("assets/fonts/DejaVuSans.ttf").arrayBuffer();
      const dejavuBold = await Bun.file("assets/fonts/DejaVuSans-Bold.ttf").arrayBuffer();
      return [
        { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
        { name: "Inter", data: bold, weight: 700 as const, style: "normal" as const },
        { name: "DejaVu Sans", data: dejavu, weight: 400 as const, style: "normal" as const },
        { name: "DejaVu Sans", data: dejavuBold, weight: 700 as const, style: "normal" as const },
      ];
    })();
  }
  return fontsPromise;
}

function row(label: string, value: string): El {
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 22,
      paddingBottom: 22,
      borderBottom: `2px solid ${SAND_LINE}`,
    },
    text(label, { fontSize: 34, color: TAUPE, fontWeight: 400 }),
    text(value, {
      fontSize: 36,
      color: ESPRESSO,
      fontWeight: 700,
      marginLeft: 24,
    }),
  );
}

function shell(
  logo: string | null,
  title: string,
  subtitle: string,
  amount: string,
  unit: string,
  body: El[],
  qrDataUrl?: string,
  footer?: string,
): El {
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: W,
      height: H,
      backgroundColor: WARM_BONE,
      fontFamily: 'Inter, "DejaVu Sans", sans-serif',
    },
    el(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        backgroundColor: EMBER_NIGHT,
        paddingTop: 64,
        paddingBottom: 56,
        paddingLeft: 72,
        paddingRight: 72,
      },
      brandRow(logo),
      text(title, { fontSize: 40, fontWeight: 700, color: "#FFFFFF", marginTop: 36 }),
      text(subtitle, { fontSize: 32, color: "#C4B49A", marginTop: 8 }),
    ),
    el(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        paddingLeft: 72,
        paddingRight: 72,
        paddingTop: 48,
        flexGrow: 1,
      },
      el(
        "div",
        { display: "flex", flexDirection: "row", alignItems: "baseline" },
        text(amount, { fontSize: 110, fontWeight: 700, color: ESPRESSO }),
        text(unit, {
          fontSize: 44,
          fontWeight: 700,
          color: EMBER_GLOW,
          marginLeft: 20,
        }),
      ),
      ...body,
      qrDataUrl
        ? el(
            "div",
            {
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              marginTop: 40,
            },
            {
              type: "img",
              props: { src: qrDataUrl, width: 200, height: 200 },
            } as unknown as El,
            text("Scan to verify this receipt", {
              fontSize: 30,
              color: TAUPE,
              marginLeft: 32,
            }),
          )
        : text("", {}),
    ),
    el(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        paddingLeft: 72,
        paddingRight: 72,
        paddingBottom: 48,
      },
      footer ? text(footer, { fontSize: 28, color: TAUPE }) : text("", {}),
      el("div", {
        height: 12,
        borderRadius: 6,
        backgroundColor: EMBER_GLOW,
        marginTop: 24,
      }),
    ),
  );
}

async function qr(url?: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    // SVG, not PNG: satori/resvg pass SVG data-URLs through (proven by
    // the logo embed); PNG data-URLs were silently dropped — every
    // receipt shipped without its QR. Vector output is sharper anyway.
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 200 });
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  } catch (err) {
    log("warn", "Receipt QR failed (continuing without)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** "3 Oct 2026, 15:52" — chat-receipt timestamp. */
export function receiptTimestamp(d = new Date()): string {
  const date = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date}, ${time}`;
}
export async function renderReceipt(data: ReceiptData): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const logo = await loadLogo();
  let root: El;
  if (data.kind === "credit") {
    root = shell(
      logo,
      "Money sent",
      `${maskPhone(data.fromPhone)} to ${maskPhone(data.toPhone)}`,
      formatNum(data.amount),
      data.currency,
      [
        row("Transfer ID", shortAddress(data.transferId)),
        row("Date", data.timestamp),
      ],
      await qr(data.receiptUrl),
      data.receiptUrl ? "Verify at the link above." : undefined,
    );
  } else if (data.kind === "onchain") {
    root = shell(
      logo,
      "Sent on Solana",
      `to ${shortAddress(data.toAddress)} · devnet`,
      formatNum(data.amount),
      data.unit ?? "SOL",
      [
        row("Signature", shortAddress(data.signature)),
        row("Date", data.timestamp),
      ],
      await qr(data.solscanUrl),
      "Verify on Solscan.",
    );
  } else {
    root = shell(
      logo,
      "Buy confirmed",
      "Fiat on-ramp · Paystack",
      data.amountMinorLabel,
      "",
      [row("Reference", shortAddress(data.reference)), row("Date", data.timestamp)],
      await qr(data.receiptUrl),
      data.receiptUrl ? "Scan to verify this receipt." : undefined,
    );
  }
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: W,
    height: H,
    fonts,
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: W } })
    .render()
    .asPng();
}

/**
 * First-contact welcome image: brand card with capabilities.
 * Sent once (unknown users). QR opens the KYC page.
 */
export async function renderWelcome(kycPageUrl: string): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const logo = await loadLogo();
  const capabilities = [
    "Buy with naira via Paystack",
    "Send to any phone number",
    "Send SOL to any Solana address",
    "Every payment gets a receipt",
  ];
  const root = shell(
    logo,
    "Your wallet lives in chat",
    "Custodial · Solana devnet · No seed phrases",
    "AMANA",
    "",
    capabilities.map((c) =>
      el(
        "div",
        { display: "flex", flexDirection: "row", alignItems: "center", marginTop: 26 },
        el("div", {
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: EMBER_GLOW,
          marginRight: 24,
        }),
        text(c, { fontSize: 36, color: ESPRESSO, fontWeight: 400 }),
      ),
    ),
    await qr(kycPageUrl),
    "Scan to verify your identity and unlock sending.",
  );
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: W,
    height: H,
    fonts,
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: W } })
    .render()
    .asPng();
}

/**
 * Money-request card: sent to the person being asked. Shows who asks,
 * whether they are a known contact (ledger history), and the strict
 * reply words. Glyph-safe like all images (no emoji).
 */
export async function renderRequest(data: {
  requesterLabel: string;
  contactKnown: boolean;
  amount: number;
  currency: string;
  fiatNote?: string;
}): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const logo = await loadLogo();
  const root = shell(
    logo,
    "Money request",
    data.requesterLabel,
    formatNum(data.amount),
    data.currency,
    [
      row(
        "Contact",
        data.contactKnown
          ? "Transacted before"
          : "Never transacted — stranger",
      ),
      ...(data.fiatNote ? [row("Value", data.fiatNote)] : []),
    ],
    undefined,
    "Reply ACCEPT, REJECT, or REJECT AND BLOCK.",
  );
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: W,
    height: H,
    fonts,
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: W } })
    .render()
    .asPng();
}
/**
 * PIN-guard image: shown with EVERY PIN prompt. Crossed-eye motif is a
 * proper inline SVG (satori passes SVG data-URLs through <img> — same
 * mechanism as the QR codes). No emoji — images must stay glyph-safe.
 * Reminds the user to shield the screen before typing their PIN.
 */
export async function renderPinGuard(): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const logo = await loadLogo();
  const DEEP_EMBER = "#B53F00";
  const eyeSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 140">` +
    `<path d="M12 70 Q110 -6 208 70 Q110 146 12 70 Z" fill="#FFFFFF" stroke="${ESPRESSO}" stroke-width="11" stroke-linejoin="round"/>` +
    `<circle cx="110" cy="70" r="30" fill="${EMBER_GLOW}"/>` +
    `<circle cx="110" cy="70" r="13" fill="${ESPRESSO}"/>` +
    `<circle cx="119" cy="61" r="5" fill="#FFFFFF"/>` +
    `<line x1="30" y1="118" x2="190" y2="22" stroke="${DEEP_EMBER}" stroke-width="16" stroke-linecap="round"/>` +
    `</svg>`;
  const eye = {
    type: "img",
    props: {
      src: `data:image/svg+xml;base64,${Buffer.from(eyeSvg).toString("base64")}`,
      width: 360,
      height: 229,
    },
  } as unknown as El;
  const rows = [
    "Shield your screen from onlookers",
    "Never share your PIN with anyone",
    "Delete your PIN message after sending",
  ].map((c) =>
    el(
      "div",
      { display: "flex", flexDirection: "row", alignItems: "center", marginTop: 26 },
      el("div", {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: EMBER_GLOW,
        marginRight: 24,
      }),
      text(c, { fontSize: 36, color: ESPRESSO, fontWeight: 400 }),
    ),
  );
  const root = shell(
    logo,
    "Eyes off the screen",
    "Entering your transaction PIN",
    "••••",
    "",
    [
      el(
        "div",
        {
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          marginTop: 24,
          marginBottom: 16,
        },
        eye,
      ),
      ...rows,
    ],
    undefined,
    "Amana staff will never ask for your PIN.",
  );
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: W,
    height: H,
    fonts,
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: W } })
    .render()
    .asPng();
}
