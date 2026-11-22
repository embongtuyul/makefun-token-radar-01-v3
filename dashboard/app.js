// Token Radar v3 — dashboard logic. Data comes from z-data.js (window.RADAR),
// written by main.ts from the sealed snapshot. No network, no fetches.
(function () {
  'use strict';
  var DATA = window.RADAR || { meta: {}, rows: [] };
  var rows = DATA.rows || [];
  var meta = DATA.meta || {};

  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 0) return '-$' + money(-n).slice(1);
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    if (n == null || isNaN(n)) return '—';
    var neg = n < 0; n = Math.abs(Math.round(n));
    var s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-$' : '$') + s;
  }
  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- header stats ----
  var u = meta.universe || {};
  var vc = meta.verdict_counts || {};
  $('asof').textContent = 'Snapshot: ' + (meta.as_of || '—') + ' · ' + (u.protocols || rows.length) + ' protocols';
  $('stats').innerHTML = [
    [rows.length, 'protocols ranked'],
    [(u.watchlist_covered || 0) + ' / ' + (u.watchlist || 0), 'watchlist covered'],
    [money(meta.total_expected_usd), 'total expected value'],
    [pct(meta.median_odds || 0), 'median listing odds'],
    [vc.FARM || 0, 'FARM verdicts'],
    [(u.traded_comps || 0), 'traded comps fitted'],
  ].map(function (s) {
    return '<div class="stat"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div>';
  }).join('');

  // ---- filter options ----
  var cats = {}, chains = {};
  rows.forEach(function (r) {
    if (r.category) cats[r.category] = 1;
    (r.chains || []).forEach(function (c) { chains[c] = 1; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    $('f-cat').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>');
  });
  Object.keys(chains).sort().forEach(function (c) {
    $('f-chain').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>');
  });

  // ---- filtering + sorting ----
  var SORTERS = {
    expected: function (a, b) { return b.expected_usd - a.expected_usd; },
    odds: function (a, b) { return b.odds - a.odds; },
    implied: function (a, b) { return b.implied_raw_usd - a.implied_raw_usd; },
    tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
    nph: function (a, b) { return b.net_per_hour_usd - a.net_per_hour_usd; },
    name: function (a, b) { return a.name.localeCompare(b.name); },
  };

  function current() {
    var q = $('q').value.trim().toLowerCase();
    var v = $('f-verdict').value, cat = $('f-cat').value, ch = $('f-chain').value;
    var wl = $('f-watch').checked;
    var list = rows.filter(function (r) {
      if (v && r.verdict !== v) return false;
      if (cat && r.category !== cat) return false;
      if (ch && (r.chains || []).indexOf(ch) < 0) return false;
      if (wl && !r.watchlist) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    list.sort(SORTERS[$('f-sort').value] || SORTERS.expected);
    return list;
  }

  function render() {
    var list = current();
    $('count').textContent = list.length + ' of ' + rows.length + ' rows';
    $('rows').innerHTML = list.map(function (r) {
      var nph = r.net_per_hour_usd;
      var cls = nph < 0 ? 'neg' : nph > 0 ? 'pos' : '';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' +
        (r.watchlist ? ' <span class="wl">WATCHLIST</span>' : '') +
        '<div class="sub">' + esc(r.category || 'Uncategorized') + ' · ' + esc((r.chains || []).slice(0, 3).join(', ')) + '</div></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + money(r.implied_raw_usd) + '</td>' +
        '<td class="num">' + pct(r.odds) + '</td>' +
        '<td class="num"><b>' + money(r.expected_usd) + '</b></td>' +
        '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td>' +
        '<td class="num ' + cls + '">' + (nph < 0 ? '-' : '') + '$' + Math.abs(nph).toFixed(2) + '</td>' +
        '</tr>';
    }).join('');
  }

  // ---- detail view ----
  function detail(r) {
    var d = $('detail');
    var sens = r.sensitivity || { tvl_multiples: [], shares: [], values: [] };
    var sensRows = sens.tvl_multiples.map(function (m, i) {
      return '<tr><td class="num">' + m + 'x TVL</td>' +
        sens.values[i].map(function (v) { return '<td class="num">' + money(v) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var compRows = (r.comps || []).map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td><td class="num">' + money(c.tvl_usd) +
        '</td><td class="num">' + money(c.mcap_usd) + '</td><td class="num">' + (c.mcap_tvl === 0 ? '&lt;0.01' : c.mcap_tvl) + 'x</td></tr>';
    }).join('');
    d.innerHTML =
      '<button class="close" id="d-close">Close ✕</button>' +
      '<h2>#' + r.rank + ' ' + esc(r.name) + ' <span class="pill ' + r.verdict + '">' + r.verdict + '</span></h2>' +
      '<div class="sub">' + esc(r.category || 'Uncategorized') + ' · ' + esc((r.chains || []).join(', ')) +
      ' · age ' + r.age_years + ' yrs · 7d TVL ' + (r.change_7d == null ? 'n/a' : r.change_7d + '%') +
      (r.watchlist ? ' · <span class="wl">ON THE WATCHLIST</span>' : '') + '</div>' +
      '<div class="kv">' +
      '<div><b>' + moneyFull(r.implied_raw_usd) + '</b><span>implied value</span></div>' +
      '<div><b>' + pct(r.odds) + '</b><span>listing odds</span></div>' +
      '<div><b>' + moneyFull(r.expected_usd) + '</b><span>expected value (× 10% share)</span></div>' +
      '<div><b class="' + (r.net_usd < 0 ? 'neg' : 'pos') + '">' + moneyFull(r.net_usd) + '</b><span>net, $1,000 / 12-wk farm</span></div>' +
      '</div>' +
      '<p class="math">' + moneyFull(r.implied_raw_usd) + ' implied × ' + pct(r.odds) + ' odds × 10% farmer share = ' +
      moneyFull(r.expected_usd) + ' expected &nbsp;·&nbsp; farmer take ' + moneyFull(r.per_farmer_usd) +
      ' − ' + moneyFull(r.cost_usd) + ' gas = ' + moneyFull(r.net_usd) + ' net (' +
      moneyFull(r.net_per_hour_usd) + '/h over ' + r.hours + ' h)</p>' +
      '<h3>Nearest traded comps — the protocols behind this implied value</h3>' +
      '<table><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Mcap / TVL</th></tr></thead>' +
      '<tbody>' + compRows + '</tbody></table>' +
      '<h3>Sensitivity — expected value vs TVL and farmer share</h3>' +
      '<table><thead><tr><th></th>' + sens.shares.map(function (s) { return '<th class="num">' + (s * 100) + '% share</th>'; }).join('') +
      '</tr></thead><tbody>' + sensRows + '</tbody></table>' +
      '<h3>Farm plan — $1,000, 12 weeks, about ' + r.hours + ' hours, ~' + moneyFull(r.cost_usd) + ' gas</h3>' +
      '<ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    d.hidden = false;
    $('d-close').addEventListener('click', function () { d.hidden = true; });
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    var r = rows.filter(function (x) { return x.slug === tr.getAttribute('data-slug'); })[0];
    if (r) detail(r);
  });
  ['q', 'f-verdict', 'f-cat', 'f-chain', 'f-watch', 'f-sort'].forEach(function (id) {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  });

  // ---- initial state from the URL (?detail=slug, ?verdict=FARM, ?sort=nph) ----
  var params = new URLSearchParams(location.search);
  if (params.get('verdict')) $('f-verdict').value = params.get('verdict');
  if (params.get('category')) $('f-cat').value = params.get('category');
  if (params.get('sort')) $('f-sort').value = params.get('sort');
  if (params.get('watchlist')) $('f-watch').checked = true;
  render();
  var slug = params.get('detail');
  if (slug) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (r) detail(r);
  }
})();
