# Token Radar v3 — research note

This note documents the model behind the board. Every number here is computed
by `main.ts` from the sealed snapshot at run time — nothing is hardcoded from
an outside list, and no protocol is named by hand anywhere in the model. The
same figures appear in `board.json` under `model` and `validation`.

## The question

Which pre-token protocol is worth farming next? The board answers it in two
parts: how big the launch would be if it happened (implied value), and how
likely it is to happen at all (listing odds). The ranking is the product:
**expected value = implied value x listing odds x 10% farmer share.**

## The universe

Snapshot as of 2026-11-14: 758 protocols at or above $5M TVL. 342 record no
token (both `gecko_id` and `symbol` null). 144 of those are wrapped, staked or
bridged products, versioned names, or exchange products — not launches of
their own — and are excluded by the same rule the watchlist uses. The board
ranks the remaining **198**. All **40** watchlist protocols are covered.

## Model 1 — the size curve (implied value)

Fitted by OLS on the 128 traded comps (protocols with a token and a market cap):

    log(mcap) = 6.9646 + 0.5223 * log(TVL)      R² = 0.194, n = 128

Then four tilts, all from the snapshot's own fields:

- **Category adjustment:** each category's mean residual from the curve,
  shrunk by n/(n+20) and clipped to ±0.5 in log space. (Lending −0.25,
  Liquid Staking −0.31, Basis Trading +0.28 — the curve systematically
  over/under-prices some categories, and the board corrects for it.)
- **Growth tilt:** `1 + 0.20*tanh(change_7d/25)`, clipped to [0.7, 1.4];
  1.0 when `change_7d` is null. Fast growers are worth more than the curve
  alone says; shrinkers less.
- **Maturity tilt:** `0.85 + 0.30*(1 - exp(-age/2))`. A protocol that has
  run for years with no token has a deeper record to price off than a
  three-month-old one.
- **Reach tilt:** `1 + 0.05*min(5, chains-1)`. Multi-chain protocols reach
  more users and more liquidity.

Implied value = exp(curve + category adj) × growth × maturity × reach.
Range on this board: $2.7M – $122.1M, median $7.3M.

## Model 2 — listing odds (the v3 addition)

A logistic regression of `P(records a token)` on log TVL and age, fitted on
all 758 protocols by Newton/IRLS (features standardized):

    logit P(token) = 0.2367 + 0.0692*z(log TVL) + 0.7459*z(age)
                     + category offset
    centers: log TVL 17.73 (sd 1.81), age 2.02y (sd 1.24)

Age dominates: older protocols are far more likely to record a token, and
the fit says a protocol that looks like the ones that launched — old, large,
in a token-heavy category — is the better launch bet. The **category offset**
is each category's shrunk empirical logit offset (n/(n+15), clipped to ±0.8):
Lending +0.80 and Dexs +0.73 raise the odds; CEX −0.80 and Risk Curators
−0.80 lower them. Odds on the board run 14% – 94%, median 43%.

Why a cross-sectional fit answers a forward question: the snapshot cannot
show the future, so the odds are a propensity — how often protocols that look
like this one have a token — not a forecast of a date. The board never claims
a protocol *will* launch, only that its profile matches launchers.

## The farm plan and the verdict

Each row prices a **reference farm: $1,000 deployed for 12 weeks, about 20
hours of work** (2h setup + 1.5h/week). The farmer's share of the airdrop
pool is `stake / TVL × 5` — pro-rata by capital, times 5 for an early,
active farmer (points systems pay multiples to streaks and early users).
Gas is priced per chain (Ethereum $5/tx, L2s ~$0.30, Solana $0.05) for one
transaction a week per chain, plus $15 bridging.

    per-farmer value = expected value × pool share
    net = per-farmer value − gas        net $/h = net / 20 h

**Verdicts:** FARM when net > $25, THIN when net > $0, else SKIP.
On this board: **80 FARM / 39 THIN / 79 SKIP.**

The honest tension in the board: the biggest launches (Steakhouse, Sentora,
Gauntlet — $2.7B TVL) rank at the top on expected value, but a $1,000 farmer
is diluted to dust there, so they carry SKIP verdicts. The best net $/h is in
small, old DEXs (MetalX Swap $14.65/h, SyncSwap $13.28/h). Rank by expected
value to find the biggest launch; sort by net $/h to find the best farm for
your capital. Both views are on the page.

## Validation — held out, three ways, for both models

All figures below are computed by `main.ts` at run time from the snapshot.

**Size curve.** In-sample R² 0.194; leave-one-out R² 0.170; 5-fold CV
(folds by slug hash) R² 0.174, Spearman 0.415. Walk-forward — train on
comps listed before the cutoff, rank those listed after — Spearman 0.328
(cutoff 2023-01-01), 0.348 (2024-01-01), 0.314 (2024-07-01). Absolute
levels shift with market regime (out-of-time R² is near zero), but the
curve *ranks* held-out launches better than chance at every cutoff, and
ranking is what the board does. The sensitivity matrix on each row shows
how the value moves if TVL halves or doubles.

**Listing odds.** In-sample AUC 0.692, Brier 0.220 vs 0.248 for the
base-rate predictor. 5-fold CV AUC 0.683, Brier 0.222. Walk-forward AUC
0.657 (2023-01-01), 0.520 (2024-01-01), 0.569 (2024-07-01) — the 2024
cutoff is nearly uninformative, because protocols listed after it are
mostly young and the model trained on older ones miscalibrates there.
The odds are a weak but real signal, and the board shows them next to
every value so a reader can discount them.

## Assumptions, stated plainly

- Farmer share is 10% of implied value (the standard community/airdrop
  allocation). The sensitivity matrix varies it 5% / 10% / 20%.
- The reference farmer deploys $1,000 and earns 5× pro-rata. Larger
  stakes scale the per-farmer value linearly; the verdicts move with them.
- "Records no token" is DefiLlama's record, not proof a protocol has none.
- Implied values are this entry's claim, never make.fun's.

## Files

- `main.ts` — fits both models, validates them, builds the board.
- `app.js` — renders, sorts, filters, and opens the detail view.
- `z-data.js` — generated at run time: the 198 rows the page reads.
