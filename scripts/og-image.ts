import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

/**
 * OG image v3 (run locally, commit the PNG):
 *   bun run scripts/og-image.ts
 * 1200x630 GraphQL-style composition: text left, chat mock bleeding
 * off the bottom-right edge, small doodle tile behind.
 */

type El = { type: string; props: Record<string, unknown> };
const el = (
  type: string,
  style: Record<string, string | number>,
  ...children: Array<El | string>
): El => ({ type, props: { style, children: children.length ? children : undefined } });
const text = (content: string, style: Record<string, string | number>): El => ({
  type: "div",
  props: { style, children: content },
});

async function loadFont(path: string, name: string, weight: 400 | 700) {
  const data = await Bun.file(path).arrayBuffer();
  return { name, data, weight, style: "normal" as const };
}

const file = (p: string) => Bun.file(p);
async function dataUrl(path: string, mime: string): Promise<string> {
  const buf = await file(path).arrayBuffer();
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

// Small crypto-doodle tile (~28px glyphs).
const TILE = (() => {
  const g = [
    '<g fill="none" stroke="#C4B49A" stroke-width="2"><circle cx="14" cy="14" r="9"/><path d="M10 14h8M14 10v8"/></g>',
    '<g fill="none" stroke="#C4B49A" stroke-width="2"><circle cx="9" cy="9" r="5"/><path d="M13 13 23 23M19 19l3-3"/></g>',
    '<g fill="none" stroke="#C4B49A" stroke-width="2"><path d="M5 6h18v12H11L5 23V6z"/></g>',
    '<g fill="none" stroke="#C4B49A" stroke-width="2"><path d="M8 20 20 8M10 8h10v10"/></g>',
    '<g fill="none" stroke="#C4B49A" stroke-width="2"><path d="M15 3 5 15h7l-1 10 9-13h-7l2-9z"/></g>',
    '<g fill="none" stroke="#C4B49A" stroke-width="2"><path d="M8 5v18M20 5v18M8 10h12M8 19h12"/></g>',
  ];
  const cells = g
    .map((glyph, i) => {
      const x = (i % 3) * 44 + 6;
      const y = Math.floor(i / 3) * 44 + 6;
      return `<g transform="translate(${x} ${y})" opacity="0.5">${glyph}</g>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="96">${cells}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
})();

const logoUrl = await dataUrl("assets/logo.svg", "image/svg+xml");
const solanaSvg = await dataUrl("../amana-frontend/public/logos/solana.svg", "image/svg+xml");
const paystackSvg = await dataUrl("../amana-frontend/public/logos/paystack.svg", "image/svg+xml");
const whatsappSvg = await dataUrl("../amana-frontend/public/logos/whatsapp.svg", "image/svg+xml");

const bubbleUser = (msg: string) =>
  el(
    "div",
    { display: "flex", flexDirection: "row", justifyContent: "flex-end", marginTop: 14 },
    el(
      "div",
      { display: "flex", backgroundColor: "#FC5800", borderRadius: 18, paddingLeft: 20, paddingRight: 20, paddingTop: 12, paddingBottom: 12 },
      text(msg, { fontSize: 26, color: "#161009" }),
    ),
  );

const bubbleBot = (msg: string) =>
  el(
    "div",
    { display: "flex", flexDirection: "row", marginTop: 14 },
    el(
      "div",
      { display: "flex", backgroundColor: "#FFFFFF", borderRadius: 18, paddingLeft: 20, paddingRight: 20, paddingTop: 12, paddingBottom: 12 },
      text(msg, { fontSize: 26, color: "#2A2118" }),
    ),
  );

const root = el(
  "div",
  {
    display: "flex",
    flexDirection: "row",
    width: 1200,
    height: 630,
    backgroundColor: "#161009",
    fontFamily: "Inter, sans-serif",
    position: "relative",
    overflow: "hidden",
  },
  {
    type: "img",
    props: {
      src: TILE,
      width: 1200,
      height: 630,
      style: { position: "absolute", top: 0, left: 0, opacity: 0.22 },
    },
  } as unknown as El,
  // left: copy
  el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      width: 620,
      paddingLeft: 88,
      paddingRight: 24,
    },
    el(
      "div",
      { display: "flex", flexDirection: "row", alignItems: "center" },
      {
        type: "img",
        props: { src: logoUrl, width: 64, height: 40 },
      } as unknown as El,
      text("AMANA", {
        fontFamily: "Boldonse",
        fontSize: 24,
        color: "#FFFFFF",
        letterSpacing: 7,
        marginLeft: 16,
      }),
    ),
    text("Money that", {
      fontFamily: "Boldonse",
      fontSize: 58,
      color: "#FFFFFF",
      marginTop: 32,
    }),
    el(
      "div",
      { display: "flex", flexDirection: "row", alignItems: "center", marginTop: 4 },
      text("lives in ", {
        fontFamily: "Boldonse",
        fontSize: 58,
        color: "#FFFFFF",
      }),
      text("chat", {
        fontFamily: "Boldonse",
        fontSize: 58,
        color: "#FC5800",
        marginLeft: 18,
      }),
    ),
    text("Buy, send and cash out from WhatsApp.", {
      fontSize: 30,
      color: "#C4B49A",
      marginTop: 28,
    }),
    el(
      "div",
      { display: "flex", flexDirection: "row", alignItems: "center", marginTop: 36 },
      {
        type: "img",
        props: { src: solanaSvg, width: 30, height: 30 },
      } as unknown as El,
      {
        type: "img",
        props: { src: paystackSvg, width: 96, height: 24, style: { marginLeft: 36 } },
      } as unknown as El,
      {
        type: "img",
        props: { src: whatsappSvg, width: 30, height: 30, style: { marginLeft: 36 } },
      } as unknown as El,
    ),
  ),
  // right: chat mock, bleeding off the bottom edge
  el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: 580,
      paddingRight: 88,
      paddingTop: 64,
    },
    el(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#F6F1E7",
        borderRadius: 28,
        paddingTop: 26,
        paddingBottom: 40,
        paddingLeft: 28,
        paddingRight: 28,
      },
      bubbleUser("buy 2000 naira of sol"),
      bubbleBot("Bought 0.012 SOL"),
      bubbleUser("send 0.5 SOL to 0803…4567"),
      bubbleBot("Sent — receipt below"),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#161009",
          borderRadius: 14,
          marginTop: 16,
          paddingTop: 12,
          paddingBottom: 12,
        },
        text("0.5 SOL - verified on Solscan", { fontSize: 22, color: "#F6F1E7" }),
      ),
    ),
  ),
);

const fonts = [
  await loadFont("assets/fonts/Boldonse-Regular.ttf", "Boldonse", 400),
  await loadFont("assets/fonts/Inter-Regular.woff", "Inter", 400),
  await loadFont("assets/fonts/Inter-Bold.woff", "Inter", 700),
  await loadFont("assets/fonts/DejaVuSans.ttf", "DejaVu Sans", 400),
];

const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
  width: 1200,
  height: 630,
  fonts,
});
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
  .render()
  .asPng();
await Bun.write("../amana-frontend/public/og-image.png", png);
console.log("bytes:", png.length);
