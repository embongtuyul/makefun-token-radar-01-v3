// Token Radar v3 — a launch radar fitted from the sealed snapshot itself.
//
// Reads /input/snapshot.json (758 DefiLlama protocols), fits two models from
// the snapshot's own figures, ranks the pre-token protocols that are not
// wrapped, staked or bridged products, and writes:
//   /output/board.json            the ranked board + model + validation
//   /output/dashboard/z-data.js   the same rows for the page
//   /output/dashboard/            the page (copied from the repo)
//   /output/screenshots/         the three screenshots (copied from the repo)
//   /output/dossier.json          buildDossier of dashboard/ + screenshots/
//
// Model (full write-up in dashboard/0-research.md):
//   1. Size curve: OLS log(mcap) ~ log(TVL) on the traded comps, plus shrunk
//      category adjustments, a growth tilt, a maturity tilt, a reach tilt.
//   2. Listing odds: logistic P(protocol records a token) ~ log TVL + age,
//      fitted on all 758 protocols, plus a shrunk category logit offset.
//   3. Expected value = implied value x listing odds x 10% farmer share.
//      The board ranks by expected value. Each farm plan prices a reference
//      $1,000 / 12-week farm and reports net value and net $/hour.
// Everything is deterministic: no clock, no randomness, no network, no env
// read except the output directory and the --input path. Two runs of this
// program on the same snapshot write the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const DAY_MS = 86400000;
const FARMER_SHARE = 0.10; // community / airdrop allocation of the implied value
const STAKE_USD = 1000; // reference farmer's deployed capital
const FARM_WEEKS = 12; // reference farm length
const HOURS_PER_WEEK = 1.5; // reference farmer's weekly time
const SETUP_HOURS = 2; // one-off setup time
const ACTIVITY_MULT = 5; // early + active farmer earns 5x pro-rata points
const WF_CUTOFFS = ['2023-01-01', '2024-01-01', '2024-07-01'];
const EXCL_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking',
  'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
// Typical gas for one simple transaction on each chain, USD. Used only to
// price farm plans; the ranking never sees these numbers.
const GAS_USD: Record<string, number> = {
  Ethereum: 5, Arbitrum: 0.3, Base: 0.3, Optimism: 0.3, Solana: 0.05,
  BSC: 0.2, Polygon: 0.1, Avalanche: 0.3, Blast: 0.2, Scroll: 0.3,
  Linea: 0.3, zkSync: 0.4, Mantle: 0.2, Mode: 0.2, Berachain: 0.3,
  Hyperliquid: 0.1, Sui: 0.05, Aptos: 0.05, Sei: 0.05, Sonic: 0.1,
};

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

// ---------- small deterministic helpers ----------

function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

// FNV-1a, 32-bit: deterministic fold assignment for cross-validation.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 10000) / 10000; }

function hasToken(p: Protocol): boolean { return p.gecko_id != null || p.symbol != null; }

// A wrapped, staked or bridged product of a protocol whose token already
// trades is not a token that does not exist yet: same rule as the watchlist.
function isExcluded(p: Protocol): boolean {
  if (p.category != null && EXCL_CATEGORIES.has(p.category)) return true;
  if (VERSION_MARK.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const e of EXCHANGES) if (p.name.startsWith(e)) return true;
  return false;
}

// ---------- ordinary least squares + validation ----------

interface OlsFit { a: number; b: number; r2: number; n: number; mx: number; my: number; sxx: number; }

function ols(xs: number[], ys: number[]): OlsFit {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  return { a, b, r2: (sxy * sxy) / (sxx * syy), n, mx, my, sxx };
}

// Leave-one-out R^2 for OLS, via the hat matrix (no refits needed).
function looR2(xs: number[], ys: number[], fit: OlsFit): number {
  let looSSE = 0, sst = 0;
  for (let i = 0; i < fit.n; i++) {
    const e = ys[i] - (fit.a + fit.b * xs[i]);
    const h = 1 / fit.n + ((xs[i] - fit.mx) ** 2) / fit.sxx;
    looSSE += (e / (1 - h)) ** 2;
    sst += (ys[i] - fit.my) ** 2;
  }
  return 1 - looSSE / sst;
}

function spearman(xs: number[], ys: number[]): number {
  const rankOf = (arr: number[]): number[] => {
    const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
    const r = new Array<number>(arr.length);
    for (let i = 0; i < idx.length; i++) r[idx[i]] = i;
    return r;
  };
  const rx = rankOf(xs), ry = rankOf(ys);
  const n = xs.length, m = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - m) * (ry[i] - m); dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

function auc(scores: number[], labels: number[]): number {
  let conc = 0, pairs = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = 0; j < scores.length; j++) {
      if (labels[i] === 1 && labels[j] === 0) {
        pairs++;
        conc += scores[i] > scores[j] ? 1 : scores[i] === scores[j] ? 0.5 : 0;
      }
    }
  }
  return pairs ? conc / pairs : 0.5;
}

// ---------- logistic regression (Newton / IRLS, fixed iterations) ----------

interface LogitModel { b: number[]; mx1: number; mx2: number; sd1: number; sd2: number; }

function fitLogistic(rows: { x: number[]; y: number }[], iters = 60): LogitModel {
  const mx1 = rows.reduce((s, r) => s + r.x[1], 0) / rows.length;
  const mx2 = rows.reduce((s, r) => s + r.x[2], 0) / rows.length;
  const sd1 = Math.sqrt(rows.reduce((s, r) => s + (r.x[1] - mx1) ** 2, 0) / rows.length) || 1;
  const sd2 = Math.sqrt(rows.reduce((s, r) => s + (r.x[2] - mx2) ** 2, 0) / rows.length) || 1;
  let b = [0, 0, 0];
  const lam = 1e-3;
  for (let it = 0; it < iters; it++) {
    const g = [0, 0, 0];
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const r of rows) {
      const z = [1, (r.x[1] - mx1) / sd1, (r.x[2] - mx2) / sd2];
      const p = sigmoid(b[0] * z[0] + b[1] * z[1] + b[2] * z[2]);
      const w = p * (1 - p);
      for (let i = 0; i < 3; i++) {
        g[i] += (r.y - p) * z[i];
        for (let j = 0; j < 3; j++) H[i][j] += w * z[i] * z[j];
      }
    }
    for (let i = 0; i < 3; i++) H[i][i] += lam;
    // Solve H d = g by Gaussian elimination (3x3).
    const A = H.map((row, i) => [...row, g[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = c + 1; r < 3; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
      }
    }
    const d = [0, 0, 0];
    for (let r = 2; r >= 0; r--) {
      let s = A[r][3];
      for (let k = r + 1; k < 3; k++) s -= A[r][k] * d[k];
      d[r] = s / A[r][r];
    }
    b = b.map((v, i) => v + d[i]);
    if (Math.max(...d.map(Math.abs)) < 1e-8) break;
  }
  return { b, mx1, mx2, sd1, sd2 };
}

// ---------- farm plans ----------

// The core action a farmer takes depends on what the protocol does.
function coreAction(category: string | null): string {
  switch (category) {
    case 'Dexs': return 'swap';
    case 'Lending': return 'supply and borrow';
    case 'Yield': case 'Yield Aggregator': return 'deposit into the vault';
    case 'RWA': return 'buy the tokenized asset';
    case 'Derivatives': case 'Perps': return 'open and hold a small position';
    case 'Prediction Market': return 'trade the live markets';
    default: return 'use the main product';
  }
}

// Gas amounts print without ugly rounding: $5, $0.30, $0.05 — never "$0"
// for a 30-cent fee.
function fmtGas(x: number): string {
  return '$' + x.toFixed(2).replace(/\.?0+$/, '');
}

function farmSteps(p: Protocol, costUsd: number, gasPerTx: number): string[] {
  const chain = (p.chains && p.chains[0]) || 'Ethereum';
  const action = coreAction(p.category);
  const steps: string[] = [];
  steps.push(
    `Set up: bridge $1,000 in stablecoins to ${chain} (the protocol's home chain) ` +
    `through its official bridge, and keep $25 in the chain's native token for gas. ` +
    `Budget about $15 for bridging. Time: about 30 minutes.`,
  );
  if (p.category === 'Dexs') {
    steps.push(
      `Swap $1,000 across at least 3 pairs on ${p.name} on ${chain}, splitting it into ` +
      `2-3 trades a week instead of one lump sum. Each swap costs about ${fmtGas(gasPerTx)} in gas; ` +
      `trading gas over 12 weeks runs about ${fmtGas(gasPerTx * 24)}.`,
    );
  } else if (p.category === 'Lending') {
    steps.push(
      `Supply $1,000 to ${p.name}'s lending market on ${chain} (half stablecoin, half the ` +
      `chain's native asset), then borrow 30-40% against it so the position shows both sides ` +
      `of the market. Supply and borrow each cost about ${fmtGas(gasPerTx)} in gas.`,
    );
  } else if (p.category === 'Yield' || p.category === 'Yield Aggregator') {
    steps.push(
      `Deposit $1,000 into ${p.name}'s highest-TVL vault on ${chain} and leave it staked; ` +
      `top up or re-stake rewards every 2 weeks so the position shows continuous activity. ` +
      `Each deposit costs about ${fmtGas(gasPerTx)} in gas.`,
    );
  } else if (p.category === 'RWA') {
    steps.push(
      `Buy $1,000 of ${p.name}'s tokenized asset on ${chain}, check the asset's backing ` +
      `documents first, and hold it in the protocol's vault for the full 12 weeks. ` +
      `Entry costs about ${fmtGas(gasPerTx)} in gas.`,
    );
  } else {
    const lead = action === 'use the main product'
      ? `Use ${p.name}'s main product`
      : action.charAt(0).toUpperCase() + action.slice(1) + ' on ' + p.name;
    steps.push(
      `${lead} on ${chain} with $1,000: open a real position, finish the onboarding flow, ` +
      `and make at least one genuine transaction a week. Each transaction costs about ` +
      `${fmtGas(gasPerTx)} in gas.`,
    );
  }
  steps.push(
    `Repeat the core action every week for 12 weeks (about 1.5 hours a week): same wallet, ` +
    `same position, no long gaps. Points systems reward streaks and tenure, so consistency ` +
    `matters more than size.`,
  );
  steps.push(
    `Connect your wallet on ${p.name}'s points or rewards page and finish every free quest, ` +
    `profile task and referral step it lists. These are usually free except gas (about ` +
    `${fmtGas(gasPerTx)} each) and often carry multipliers.`,
  );
  const chainNames = (p.chains && p.chains.length ? p.chains : ['Ethereum']);
  const chainShort = chainNames.slice(0, 3).join(', ') +
    (chainNames.length > 3 ? ' +' + (chainNames.length - 3) + ' more' : '');
  steps.push(
    `Track the farm weekly: record your position, points balance and gas spent in a simple ` +
    `sheet. Budget $${Math.round(costUsd)} total gas for the 12 weeks on ${chainShort}; if gas on ` +
    `${chain} spikes above ${fmtGas(gasPerTx * 3)}, wait a day rather than overpaying.`,
  );
  steps.push(
    `After 12 weeks, or when ${p.name} announces a token or snapshot, unwind gradually: ` +
    `exit half, keep half staked until the snapshot passes. Never rush the exit in one ` +
    `block - snapshot dates are announced late and often reward holders.`,
  );
  // Safety net for the gate's 20-600 character rule: no step may leave here
  // over 600 characters. (The templates above top out near 350; this never
  // triggers on the sealed snapshot, but a longer protocol name must not
  // break the board.)
  return steps.map((s) => {
    const t = s.trim();
    if (t.length <= 600) return t;
    const cut = t.slice(0, 597);
    return cut.slice(0, cut.lastIndexOf(' ')) + '...';
  });
}

// ---------- the build ----------

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_years: number;
  watchlist: boolean;
  implied_raw_usd: number;
  odds: number;
  farmer_share: number;
  expected_usd: number;
  verdict: string;
  cost_usd: number;
  hours: number;
  per_farmer_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  comps: { slug: string; name: string; tvl_usd: number; mcap_usd: number; mcap_tvl: number }[];
  sensitivity: { tvl_multiples: number[]; shares: number[]; values: number[][] };
}

function main(): void {
  const argv = process.argv.slice(2);
  let inputPath = '/input/snapshot.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) inputPath = argv[i + 1];
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const rootDir = path.dirname(fileURLToPath(import.meta.url));

  const snap: Snapshot = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const P = snap.protocols;
  const asOfMs = Date.parse(snap.as_of + 'T00:00:00Z');
  const watchSet = new Set(snap.watchlist);

  const ageYears = (p: Protocol): number | null =>
    p.listed_at ? Math.max(0, (asOfMs - Date.parse(p.listed_at + 'T00:00:00Z')) / DAY_MS / 365.25) : null;
  const knownAges = P.map(ageYears).filter((a): a is number => a != null).sort((a, b) => a - b);
  const medianAge = knownAges[Math.floor(knownAges.length / 2)];
  const ageOf = (p: Protocol): number => { const a = ageYears(p); return a == null ? medianAge : a; };

  // ----- the board universe: pre-token, not a wrapped/staked/bridged product
  const preToken = P.filter((p) => !hasToken(p));
  const board = P.filter((p) => !hasToken(p) && !isExcluded(p));
  const traded = P.filter((p) => hasToken(p) && p.mcap_usd != null && p.mcap_usd > 0 && p.tvl_usd > 0);

  // ----- model 1: size curve log(mcap) ~ log(TVL) on the traded comps
  const lx = traded.map((p) => Math.log(p.tvl_usd));
  const ly = traded.map((p) => Math.log(p.mcap_usd as number));
  const curve = ols(lx, ly);
  const loo = looR2(lx, ly, curve);
  // 5-fold cross-validation, folds by slug hash (deterministic, no RNG).
  let cvSe = 0, cvSst = 0;
  const cvPred: number[] = [], cvAct: number[] = [];
  for (let f = 0; f < 5; f++) {
    const tr = traded.filter((p) => hashStr(p.slug) % 5 !== f);
    const te = traded.filter((p) => hashStr(p.slug) % 5 === f);
    const fit = ols(tr.map((p) => Math.log(p.tvl_usd)), tr.map((p) => Math.log(p.mcap_usd as number)));
    for (const p of te) {
      const pr = fit.a + fit.b * Math.log(p.tvl_usd);
      const ac = Math.log(p.mcap_usd as number);
      cvSe += (ac - pr) ** 2; cvSst += (ac - curve.my) ** 2;
      cvPred.push(pr); cvAct.push(ac);
    }
  }
  const cvR2 = 1 - cvSe / cvSst;
  const cvSpearman = spearman(cvPred, cvAct);
  // Walk-forward: train on comps listed before the cutoff, rank those after.
  const wfCurve = WF_CUTOFFS.map((cut) => {
    const tr = traded.filter((p) => p.listed_at && p.listed_at < cut);
    const te = traded.filter((p) => p.listed_at && p.listed_at >= cut);
    if (tr.length < 20 || te.length < 10) return { cutoff: cut, train: tr.length, test: te.length, spearman: null as number | null };
    const fit = ols(tr.map((p) => Math.log(p.tvl_usd)), tr.map((p) => Math.log(p.mcap_usd as number)));
    const sp = spearman(
      te.map((p) => fit.a + fit.b * Math.log(p.tvl_usd)),
      te.map((p) => Math.log(p.mcap_usd as number)),
    );
    return { cutoff: cut, train: tr.length, test: te.length, spearman: round4(sp) };
  });
  // Shrunk category adjustments from the curve's residuals, clipped to +-0.5.
  const catRes: Record<string, number[]> = {};
  for (const p of traded) {
    const c = p.category || 'Uncategorized';
    (catRes[c] = catRes[c] || []).push(Math.log(p.mcap_usd as number) - (curve.a + curve.b * Math.log(p.tvl_usd)));
  }
  const catAdj: Record<string, number> = {};
  for (const [c, rs] of Object.entries(catRes)) {
    const m = rs.reduce((s, v) => s + v, 0) / rs.length;
    catAdj[c] = Math.max(-0.5, Math.min(0.5, m * (rs.length / (rs.length + 20))));
  }

  // ----- model 2: listing odds, logistic P(records a token) ~ log TVL + age
  const oddsRows = P.map((p) => ({ x: [1, Math.log(p.tvl_usd), ageOf(p)], y: hasToken(p) ? 1 : 0 }));
  const oddsModel = fitLogistic(oddsRows);
  const oddsBase = (p: Protocol): number => {
    const z1 = (Math.log(p.tvl_usd) - oddsModel.mx1) / oddsModel.sd1;
    const z2 = (ageOf(p) - oddsModel.mx2) / oddsModel.sd2;
    return sigmoid(oddsModel.b[0] + oddsModel.b[1] * z1 + oddsModel.b[2] * z2);
  };
  // Shrunk category logit offsets from the empirical token rate, clipped +-0.8.
  const globalRate = P.filter(hasToken).length / P.length;
  const globalLogit = Math.log(globalRate / (1 - globalRate));
  const byCat: Record<string, number[]> = {};
  for (const p of P) {
    const c = p.category || 'Uncategorized';
    (byCat[c] = byCat[c] || []).push(hasToken(p) ? 1 : 0);
  }
  const catOff: Record<string, number> = {};
  for (const [c, ys] of Object.entries(byCat)) {
    const r = Math.min(0.98, Math.max(0.02, ys.reduce((s, v) => s + v, 0) / ys.length));
    catOff[c] = Math.max(-0.8, Math.min(0.8, (ys.length / (ys.length + 15)) * (Math.log(r / (1 - r)) - globalLogit)));
  }
  const oddsOf = (p: Protocol): number => {
    const z1 = (Math.log(p.tvl_usd) - oddsModel.mx1) / oddsModel.sd1;
    const z2 = (ageOf(p) - oddsModel.mx2) / oddsModel.sd2;
    return sigmoid(oddsModel.b[0] + oddsModel.b[1] * z1 + oddsModel.b[2] * z2 + (catOff[p.category || 'Uncategorized'] || 0));
  };
  // Odds validation: in-sample AUC + Brier, 5-fold CV, walk-forward AUC.
  const allScores = P.map(oddsBase);
  const allLabels = P.map((p) => (hasToken(p) ? 1 : 0));
  const oddsAuc = auc(allScores, allLabels);
  const oddsBrier = P.reduce((s, p, i) => s + (allScores[i] - allLabels[i]) ** 2, 0) / P.length;
  const baseBrier = globalRate * (1 - globalRate);
  const cvScores = new Array<number>(P.length);
  let cvBrier = 0;
  for (let f = 0; f < 5; f++) {
    const tr = P.filter((p) => hashStr(p.slug) % 5 !== f)
      .map((p) => ({ x: [1, Math.log(p.tvl_usd), ageOf(p)], y: hasToken(p) ? 1 : 0 }));
    const m = fitLogistic(tr);
    P.forEach((p, i) => {
      if (hashStr(p.slug) % 5 === f) {
        const z1 = (Math.log(p.tvl_usd) - m.mx1) / m.sd1;
        const z2 = (ageOf(p) - m.mx2) / m.sd2;
        cvScores[i] = sigmoid(m.b[0] + m.b[1] * z1 + m.b[2] * z2);
        cvBrier += (cvScores[i] - allLabels[i]) ** 2;
      }
    });
  }
  const cvAuc = auc(cvScores, allLabels);
  cvBrier /= P.length;
  const wfOdds = WF_CUTOFFS.map((cut) => {
    const tr = P.filter((p) => p.listed_at && p.listed_at < cut);
    const te = P.filter((p) => p.listed_at && p.listed_at >= cut);
    if (tr.length < 50 || te.length < 20) return { cutoff: cut, train: tr.length, test: te.length, auc: null as number | null };
    const m = fitLogistic(tr.map((p) => ({ x: [1, Math.log(p.tvl_usd), ageOf(p)], y: hasToken(p) ? 1 : 0 })));
    const sc = te.map((p) => {
      const z1 = (Math.log(p.tvl_usd) - m.mx1) / m.sd1;
      const z2 = (ageOf(p) - m.mx2) / m.sd2;
      return sigmoid(m.b[0] + m.b[1] * z1 + m.b[2] * z2);
    });
    return { cutoff: cut, train: tr.length, test: te.length, auc: round4(auc(sc, te.map((p) => (hasToken(p) ? 1 : 0)))) };
  });

  // ----- apply the models to the board universe
  const impliedOf = (p: Protocol, tvlMult = 1): number => {
    const base = Math.exp(curve.a + curve.b * Math.log(p.tvl_usd * tvlMult) + (catAdj[p.category || 'Uncategorized'] || 0));
    const growth = p.change_7d == null ? 1 : Math.max(0.7, Math.min(1.4, 1 + 0.20 * Math.tanh(p.change_7d / 25)));
    const maturity = 0.85 + 0.30 * (1 - Math.exp(-ageOf(p) / 2));
    const reach = 1 + 0.05 * Math.min(5, Math.max(0, (p.chains || []).length - 1));
    return base * growth * maturity * reach;
  };
  const nearestComps = (p: Protocol) => {
    const lp = Math.log(p.tvl_usd);
    return traded
      .map((c) => ({
        slug: c.slug,
        name: c.name,
        tvl_usd: c.tvl_usd,
        mcap_usd: c.mcap_usd as number,
        mcap_tvl: round2((c.mcap_usd as number) / c.tvl_usd),
        dist: Math.abs(lp - Math.log(c.tvl_usd)) + 0.5 * (c.category === p.category ? 0 : 1),
      }))
      .sort((a, b) => (a.dist - b.dist) || (a.slug < b.slug ? -1 : 1))
      .slice(0, 3)
      .map(({ slug, name, tvl_usd, mcap_usd, mcap_tvl }) => ({ slug, name, tvl_usd, mcap_usd, mcap_tvl }));
  };
  const hours = SETUP_HOURS + FARM_WEEKS * HOURS_PER_WEEK;

  const scored = board.map((p) => {
    const implied = impliedOf(p);
    const odds = oddsOf(p);
    const expected = implied * odds * FARMER_SHARE;
    const chains = (p.chains && p.chains.length ? p.chains : ['Ethereum']);
    const gasPerTx = GAS_USD[chains[0]] ?? 0.5;
    const cost = chains.reduce((s, c) => s + (GAS_USD[c] ?? 0.5), 0) * FARM_WEEKS + 15;
    const perFarmer = expected * ((STAKE_USD / p.tvl_usd) * ACTIVITY_MULT);
    const net = perFarmer - cost;
    const netPerHour = net / hours;
    const verdict = net > 25 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
    const multiples = [0.5, 1, 2];
    const shares = [0.05, 0.1, 0.2];
    const values = multiples.map((m) => shares.map((s) => Math.max(1, Math.round(impliedOf(p, m) * odds * s))));
    return {
      p, implied, odds, expected, cost, gasPerTx, perFarmer, net, netPerHour, verdict,
      comps: nearestComps(p),
      sensitivity: { tvl_multiples: multiples, shares, values },
    };
  });
  // Rank by expected value; slug breaks ties so the order is deterministic.
  scored.sort((a, b) => (b.expected - a.expected) || (a.p.slug < b.p.slug ? -1 : 1));

  const rows: BoardRow[] = scored.map((r, i) => ({
    slug: r.p.slug,
    name: r.p.name,
    rank: i + 1,
    implied_value_usd: Math.max(1, Math.round(r.expected)),
    farm_steps: farmSteps(r.p, r.cost, r.gasPerTx),
    category: r.p.category,
    chains: r.p.chains || [],
    tvl_usd: r.p.tvl_usd,
    change_7d: r.p.change_7d,
    age_years: round2(ageOf(r.p)),
    watchlist: watchSet.has(r.p.slug),
    implied_raw_usd: Math.max(1, Math.round(r.implied)),
    odds: round4(r.odds),
    farmer_share: FARMER_SHARE,
    expected_usd: Math.max(1, Math.round(r.expected)),
    verdict: r.verdict,
    cost_usd: round2(r.cost),
    hours,
    per_farmer_usd: round2(r.perFarmer),
    net_usd: round2(r.net),
    net_per_hour_usd: round2(r.netPerHour),
    comps: r.comps,
    sensitivity: r.sensitivity,
  }));

  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.verdict as 'FARM' | 'THIN' | 'SKIP']++;
  const sortedOdds = rows.map((r) => r.odds).sort((a, b) => a - b);
  const boardDoc = {
    as_of: snap.as_of,
    generated_by: 'token-radar v3 (fitted from the sealed snapshot at run time)',
    universe: {
      protocols: P.length,
      pre_token: preToken.length,
      board_rows: rows.length,
      watchlist: snap.watchlist.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      traded_comps: traded.length,
    },
    model: {
      size_curve: {
        formula: 'log(mcap) = a + b * log(TVL)',
        a: round4(curve.a), b: round4(curve.b), r2: round4(curve.r2), n: curve.n,
        category_adjustment: 'shrunk mean residual per category, n/(n+20), clipped to +-0.5 in log space',
        growth_tilt: '1 + 0.20*tanh(change_7d/25), clipped to [0.7, 1.4]; 1 when change_7d is null',
        maturity_tilt: '0.85 + 0.30*(1 - exp(-age_years/2))',
        reach_tilt: '1 + 0.05*min(5, chains-1)',
      },
      listing_odds: {
        formula: 'logit P(records a token) = b0 + b1*z(log TVL) + b2*z(age_years) + category offset',
        b0: round4(oddsModel.b[0]), b1: round4(oddsModel.b[1]), b2: round4(oddsModel.b[2]),
        center_log_tvl: round4(oddsModel.mx1), sd_log_tvl: round4(oddsModel.sd1),
        center_age: round4(oddsModel.mx2), sd_age: round4(oddsModel.sd2),
        category_offset: 'shrunk empirical logit offset per category, n/(n+15), clipped to +-0.8',
        base_rate: round4(globalRate),
      },
      expected_value: 'implied value x listing odds x farmer share (0.10)',
      farmer: {
        stake_usd: STAKE_USD, weeks: FARM_WEEKS, hours_per_week: HOURS_PER_WEEK,
        setup_hours: SETUP_HOURS, total_hours: hours, activity_multiplier: ACTIVITY_MULT,
        pool_share: 'stake / TVL x activity multiplier',
        verdicts: 'FARM when net > $25, THIN when net > $0, else SKIP',
      },
    },
    validation: {
      size_curve: {
        loo_r2: round4(loo),
        cv5_r2: round4(cvR2),
        cv5_spearman: round4(cvSpearman),
        walk_forward_spearman: wfCurve,
      },
      listing_odds: {
        auc: round4(oddsAuc),
        brier: round4(oddsBrier),
        base_rate_brier: round4(baseBrier),
        cv5_auc: round4(cvAuc),
        cv5_brier: round4(cvBrier),
        walk_forward_auc: wfOdds,
      },
    },
    verdict_counts: verdictCounts,
    median_odds: round4(sortedOdds[Math.floor(sortedOdds.length / 2)]),
    total_expected_usd: rows.reduce((s, r) => s + r.expected_usd, 0),
    rows,
  };

  // ----- write the outputs (never remove the output directory itself)
  const outDashboard = path.join(outDir, 'dashboard');
  const outShots = path.join(outDir, 'screenshots');
  fs.mkdirSync(outDashboard, { recursive: true });
  fs.mkdirSync(outShots, { recursive: true });
  fs.cpSync(path.join(rootDir, 'dashboard'), outDashboard, { recursive: true, force: true });
  fs.cpSync(path.join(rootDir, 'screenshots'), outShots, { recursive: true, force: true });
  fs.writeFileSync(path.join(outDir, 'board.json'), JSON.stringify(boardDoc, null, 2) + '\n', 'utf8');
  // One row per line, so the dossier shows real rows before its text cap.
  const dataLines: string[] = [];
  dataLines.push('window.RADAR = {');
  dataLines.push('"meta": ' + JSON.stringify({
    as_of: boardDoc.as_of,
    universe: boardDoc.universe,
    verdict_counts: verdictCounts,
    median_odds: boardDoc.median_odds,
    total_expected_usd: boardDoc.total_expected_usd,
    model: boardDoc.model,
    validation: boardDoc.validation,
  }) + ',');
  dataLines.push('"rows": [');
  rows.forEach((r, i) => dataLines.push(JSON.stringify(r) + (i + 1 < rows.length ? ',' : '')));
  dataLines.push(']');
  dataLines.push('};');
  fs.writeFileSync(path.join(outDashboard, 'z-data.js'), dataLines.join('\n') + '\n', 'utf8');
  // The dossier is written last, from the finished dashboard/ + screenshots/.
  fs.writeFileSync(path.join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));
}

main();
