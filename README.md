[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/embongtuyul/makefun-token-radar-01-v3/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/embongtuyul/makefun-token-radar-01-v3/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar v3 — token-radar-01

A launch radar fitted from the sealed snapshot itself. `main.ts` reads
`/input/snapshot.json` (758 DefiLlama protocols), fits two models at run time,
ranks the 198 pre-token protocols that are not wrapped, staked or bridged
products, and writes the board, the dashboard data and the dossier.

**The model** (full write-up in `dashboard/0-research.md`):

1. **Size curve** — OLS `log(mcap) ~ log(TVL)` on the 128 traded comps, plus
   shrunk category adjustments, a growth tilt, a maturity tilt and a reach tilt.
2. **Listing odds** — logistic `P(records a token) ~ log TVL + age` fitted on
   all 758 protocols, plus a shrunk category logit offset. This is v3's core
   addition: the board ranks by **expected value = implied × odds × 10% farmer
   share**, with the odds shown on every row.
3. **Farm plans** — each row prices a reference $1,000 / 12-week farm (gas by
   chain, hours, net value, net $/hour) and carries a FARM / THIN / SKIP
   verdict. Every row also shows its 3 nearest traded comps and a 3×3
   sensitivity matrix (TVL multiple × farmer share).

**Validation, computed live at run time:** leave-one-out + 5-fold CV +
walk-forward at three cutoffs, for both models. See `board.json` (`validation`)
and `dashboard/0-research.md`.

**Run it:** `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`

**Layout:**

- `main.ts` — the program: fits the models, builds the board, writes the outputs
- `dashboard/` — `index.html`, `app.css`, `app.js`, `0-research.md` (the model
  note the judge reads first); `z-data.js` is generated at run time
- `screenshots/` — board, detail view, filtered view, captured from this dashboard
- `vendor/makefun-board.ts` — the kit's dossier library, byte-identical

Competition: [token-radar-01](https://make.fun/bounty/token-radar-01)
