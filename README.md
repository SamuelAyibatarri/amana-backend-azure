<div align="center">

<img src="./assets/logo.svg" alt="Amana logo" height="64" />

# Amana Backend

WhatsApp wallet bot + Solana devnet settlement + Paystack naira on-ramp.

Companion service to [`amana-frontend`](../amana-frontend) — the frontend owns identity, ledger, and webhooks; this service owns chat, signing, and chain.

</div>

## Overview

Amana puts a custodial wallet inside WhatsApp chat. Users buy SOL/USDC with naira, send to phone numbers or Solana addresses, request money, and check balance/history — all in natural language. Every payment returns a verifiable PNG receipt.

No seed phrases. Treasury signs and pays fees. Users authorize with a dashboard-set 4-digit PIN.

```
WhatsApp user
  ⇄ Baileys socket (in-process, QR pair, ./sessions/)
  → Gemini intent parse (Zod-validated, deterministic fallback)
  → KYC + PIN gates (frontend D1 via SHARED_SECRET)
  → Ledger credit (frontend /api/transfers/*)
  → Solana devnet (treasury send / mirror mint-burn)
  → PNG receipt (satori + resvg, QR to Solscan / receipt page)
```

Buy flow: chat confirms → Paystack checkout link → frontend webhook verifies → `POST /buy/settle` here → ledger fund + mirror mint + chat receipt.

> [!NOTE]
> Solana legs run on **devnet**. Treasury keys and mock KYC are demo-grade — KMS/HSM + real vendor before mainnet.

## Features

- **Chat wallet** — buy, send (phone/address), request, balance, history.
- **AI intent** — Gemini structured output; strict sanitizer drops bad phones/amounts; keyword fallback when key missing.
- **Fail-closed gates** — unverified users get KYC link, never a confirm screen; balance re-checked at confirm *and* at PIN approval.
- **PIN ceremony** — `idle → awaitingConfirm → awaitingPin → idle`, strict yes/no + 4-digit parsers, 5-miss 15-min lockout, PIN-guard image.
- **Phone sends** — internal ledger credit, auto-provision recipient, WhatsApp invite.
- **On-chain sends** — SOL + USDC from treasury stock, Solscan proof link.
- **Money requests** — `ACCEPT`/`REJECT`, 7-day expiry, single 24h nudge, blocklist + privacy modes.
- **Receipts** — credit / on-chain / buy / request / welcome / PIN-guard PNGs, phones always masked.
- **Proof-of-liability** — per-currency mirror mints; `GET /health/mirror` compares ledger sums vs reserve supply.
- **Live pricing** — CoinGecko SOL/USDC + fixed `USD_NGN` leg, 5-min cache, stale-then-hardcoded fallback (bot never blocks).

## Prerequisites

- [Bun](https://bun.sh) >= 1.3
- Running `amana-frontend` (default `http://localhost:8787`)
- `GOOGLE_GENAI_API_KEY` (optional — fallback parser works without it)
- Solana devnet access (public RPC, free faucet)

## Getting started

```bash
bun install
cp .env.example .env  # or copy placeholders from .env into your own .env
```

Set required vars (see [Configuration](#configuration)). `SHARED_SECRET` must equal the frontend's value.

One-time chain setup (treasury + mirror pools, devnet faucet — free):

```bash
bun run scripts/chain-setup.ts
```

This appends `TREASURY_SECRET`, `MIRROR_MINT_SOL/USDC/NGN`, `TEST_RECIPIENT_*` to `.env` (`chmod 600`, never printed).

Run:

```bash
bun run --hot index.ts  # dev, QR prints in terminal
# or
bun run index.ts        # start
bunx tsc --noEmit       # typecheck
bun test                # unit tests (intent, payments, rates, receipts, solana)
```

Scan QR with the bot line. Auth persists in `./sessions/` (gitignored). Delete it + restart to re-pair.

> [!IMPORTANT]
> Backend and frontend `SHARED_SECRET` must match or ledger calls + magic-link handshake fail.

## Usage

Chat commands (examples):

```
hi / hello                        → onboarding + KYC link
buy 2000 naira of sol              → Paystack checkout link
send 0.5 sol to 08031234567        → confirm → PIN → ledger credit
send 0.1 sol to 4Fbr…42vx          → confirm → PIN → devnet send + Solscan proof
request 5000 naira worth of usdc from 08031234567
what is my balance? / show my history
I've paid                          → re-verify outstanding Paystack checkout
```

Corrections mid-confirm (`no, make it 0.3`, `instead to 0803…`) amend the pending payment; `NO` cancels.

## API

| Method | Path | Guard | Purpose |
|--------|------|-------|---------|
| `GET` | `/health` | none | Liveness |
| `POST` | `/buy/settle` | `x-amana-secret` | Fund ledger (idempotent on reference), mint mirror, deliver buy receipt |
| `GET` | `/health/mirror` | none (calls ledger with secret) | Ledger-vs-mirror invariant per pool + Solscan links |
| `POST` | `/whatsapp/send` | `x-amana-secret` | Dumb relay — frontend magic-link delivery only |

Settle body: `{ reference, phone, asset: SOL|USDC, crypto?, rateLabel?, ngn?, amountKobo? }`. Web-initiated fundings price at settle time and print the executed rate.

## Configuration

| Var | Required | Purpose |
|-----|----------|---------|
| `PORT` | no (default `3001`) | Hono listen port |
| `FRONTEND_URL` | no (default `http://localhost:8787`) | Ledger/auth API base |
| `SHARED_SECRET` | **yes** | Constant-time-compared guard for `/buy/settle`, `/whatsapp/send`, ledger calls |
| `GOOGLE_GENAI_API_KEY` | no | Gemini classification; absent → deterministic fallback |
| `GENAI_MODEL` | no (default `gemini-2.5-flash-lite`) | Classifier model; Google retires aliases fast — update on 404 |
| `TREASURY_SECRET` | yes (via `chain-setup`) | Base58 32-byte seed, backend `.env` only |
| `MIRROR_MINT_SOL/USDC/NGN` | yes (via `chain-setup`) | Liability-matched pools |
| `USDC_MINT` | for USDC sends | Circle devnet USDC mint treasury holds |
| `USD_NGN` | no (default `1360`) | Fixed FX leg for buy pricing |

> [!WARNING]
> `.env` and `./sessions/` are gitignored and local-only. Never commit real secrets.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/chain-setup.ts` | Generate treasury, fund via faucet, create 3 mirror mints + test recipient |
| `scripts/rehearse.ts <address> [amount]` | Dry rehearsal: treasury SOL send + mirror burn, prints Solscan proof |
| `scripts/rebalance.ts` | Reconcile mirror reserve to ledger sums (mirror-gap repair) |

## Project structure

```
index.ts                 → Hono app (/health, /buy/settle, /health/mirror, /whatsapp/send) + sweep tick
whatsappbot/            → baileys.ts (socket, QR, presence), handler.ts (state machine), intent.ts, payments.ts, requests.ts
sessions-manager/       → transfers.ts, pin.ts, clearance.ts, magiclink.ts, conversation.ts
solana/                 → solana.ts (@solana/kit pipelines: sendSol/sendUsdc, mintMirror/burnMirror/mirrorMove)
receipts/               → receipts.ts (satori + resvg PNGs)
lib/                    → rates.ts (CoinGecko quote), greet.ts, name.ts, log.ts
scripts/                → chain-setup.ts, rehearse.ts, rebalance.ts
assets/                 → logo.svg, fonts (Inter + DejaVu for ₦/≈ glyphs)
sessions/               → Baileys auth (gitignored, created at runtime)
```

State machine per user: `idle → awaitingConfirm → awaitingPin → idle`, plus `awaitingPayment` (Paystack checkout) and `awaitingAccept` (money request). Pending entries expire after 30 min.

## Proof-of-liability

Each ledger currency has a mirror mint (`MIRROR_MINT_*`). Buys mint; on-chain withdrawals burn; phone-to-phone sends do a single-tx mint+burn (net-zero). `GET /health/mirror` returns per pool:

```json
{ "currency": "SOL", "configured": true, "ledgerBase": "123000000", "mirrorBase": "123000000", "match": true, "mint": "https://solscan.io/account/…?cluster=devnet" }
```

Ledger stands on mirror failure — recorded as mirror-gap in logs, repaired by `rebalance.ts`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| QR never prints | Socket already paired (`./sessions/` exists) or `dead` after 401 — delete `./sessions`, restart |
| `WhatsApp logged out (401)` | Keys rejected server-side; delete `./sessions`, re-pair with fresh QR |
| `Missing SHARED_SECRET` / `Fund failed` | `.env` mismatch with frontend `.dev.vars`; check `FRONTEND_URL` |
| `Missing TREASURY_SECRET` | Run `bun run scripts/chain-setup.ts` once |
| Intent 404 / model errors | Update `GENAI_MODEL` to replacement named in error; fallback keeps bot alive |
| `I can't price that right now` | CoinGecko down + cache empty; retry in a minute |
| Receipt image missing, text delivered | satori/resvg render failed — logged as warn, text already sent |

## Tech stack

Bun · Hono · Baileys · Gemini (`@google/genai`, Zod) · Solana Kit + SPL Token Program · satori + resvg + qrcode · Paystack (via frontend) · Better Auth + D1 (frontend ledger)

Related: [`amana-frontend`](https://github.com/SamuelAyibatarri/amana-frontend) — Next.js + Cloudflare Workers, D1 ledger, Paystack webhooks, KYC + PIN + dashboard.
