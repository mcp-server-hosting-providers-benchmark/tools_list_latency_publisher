#!/usr/bin/env node

/**
 * Reads tools_list_*.json measurement files collected by the remote MCP server
 * hosting provider latency benchmark pipeline and generates:
 *
 *   out/llms.txt              — instruction for LLM agents: points to llms.json
 *   out/llms-full.txt         — instruction for LLM agents: points to llms-full.json
 *   out/llms.json             — structured index + aggregated stats, 90-day window
 *   out/llms-full.json        — aggregated stats + individual runs, 24-hour window
 *   out/robots.txt
 *   out/index.html            — mobile-first summary table, all origins, 30-day window
 *   out/remote-mcp-server-hosting-provider/[slug].html  — detail page per provider
 *   out/tools-list-latency-from/[city-country].html     — summary filtered by pinger origin
 *   out/tools-list-latency-from/[city-country].json     — JSON filtered by pinger origin
 *
 * Usage: node publish.js [--results <path>] [--out <path>] [--base <url-prefix>]
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// --- CLI args ---
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

const results_dir = flag("--results") ?? join(import.meta.dirname, "results");
const out_dir     = flag("--out")     ?? join(import.meta.dirname, "out");
// Base URL prefix for all internal links (e.g. "/tools_list_latency_publisher" for GitHub Pages subdirectory).
// Leave empty when the site is served from the root.
const BASE = (flag("--base") ?? "").replace(/\/$/, "");
const u = (path) => `${BASE}${path}`;

// --- Percentile ---
function percentile(sorted_asc, p) {
  if (sorted_asc.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted_asc.length) - 1;
  return sorted_asc[Math.max(0, idx)];
}

// --- Geo helpers ---
const COUNTRY_NAMES = {
  AR:"Argentina", AU:"Australia", BD:"Bangladesh", BR:"Brazil", CA:"Canada",
  DE:"Germany", EG:"Egypt", ES:"Spain", FR:"France", GB:"United Kingdom",
  ID:"Indonesia", IN:"India", IT:"Italy", JP:"Japan", KR:"South Korea",
  MX:"Mexico", MY:"Malaysia", NG:"Nigeria", NL:"Netherlands", PH:"Philippines",
  PK:"Pakistan", PL:"Poland", RU:"Russia", SA:"Saudi Arabia", SE:"Sweden",
  SG:"Singapore", TH:"Thailand", TR:"Turkey", TW:"Taiwan", UA:"Ukraine",
  AE:"UAE", US:"United States", VN:"Vietnam", ZA:"South Africa"
};
const country_name = (iso) => COUNTRY_NAMES[iso] ?? iso;

function get_client_geo(data) {
  const chain = data.results?.[0]?.observed_call_chain;
  return chain?.find(c => c.role === "mcpclient")?.geo ?? null;
}

function get_server_geo(result) {
  return result.observed_call_chain?.find(c => c.role === "mcpserver")?.geo ?? null;
}

// Stable key for grouping: "City·CC"
function geo_key(geo) {
  if (!geo) return null;
  return `${geo.city ?? ""}·${geo.country_code ?? ""}`;
}

// "clichy-france"
function geo_slug(geo) {
  if (!geo) return "unknown";
  const norm = (s) => (s ?? "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${norm(geo.city)}-${norm(country_name(geo.country_code ?? ""))}`;
}

// "Paris, France"
function geo_display(geo) {
  if (!geo) return "Unknown";
  return `${geo.city ?? ""}, ${country_name(geo.country_code ?? "")}`;
}

// "Paris·FR"
function geo_short(geo) {
  if (!geo) return "Unknown";
  return `${geo.city ?? ""}·${geo.country_code ?? ""}`;
}

// Parse server_geos stored as "City·CC" strings
function server_location_display(server_geos) {
  if (!server_geos?.length) return "Unknown";
  const [city, code] = server_geos[0].split("·");
  return `${city ?? ""}, ${country_name(code ?? "")}`;
}

// --- Provider display helpers ---
function provider_display_name(internal_name) {
  return internal_name.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function provider_slug(internal_name) {
  return internal_name.replace(/_/g, "-");
}

// --- Load runs from result files ---
function load_runs(dir, since_ms = 0) {
  const files = readdirSync(dir)
    .filter(f => f.startsWith("tools_list_") && f.endsWith(".json"))
    .sort();

  const runs = [];
  for (const file of files) {
    let data;
    try { data = JSON.parse(readFileSync(join(dir, file), "utf-8")); }
    catch { continue; }

    const ts = new Date(data.date ?? 0).getTime();
    if (ts < since_ms) continue;

    const client_geo = get_client_geo(data);
    for (const r of data.results ?? []) {
      if (!r.timestamps?.mcpclient) continue;
      const ms = Math.round(
        r.timestamps.mcpclient.request_end_ms - r.timestamps.mcpclient.request_start_ms
      );
      // Capture the error type reported by the pinger (e.g. "timeout (>15000ms)")
      const error_type = (!r.ok && r.error) ? r.error : null;
      runs.push({
        ts: data.date ?? null,
        provider: r.name,
        ok: !!r.ok,
        ms: r.ok ? ms : null,
        error_type,
        client_geo,
        server_geo: get_server_geo(r)
      });
    }
  }
  return runs;
}

// --- Aggregate runs into per-provider stats ---
function aggregate(runs) {
  const by_provider = {};
  for (const run of runs) {
    if (!by_provider[run.provider]) {
      by_provider[run.provider] = { latencies: [], error_types: [], success: 0, server_geos: [] };
    }
    const pd = by_provider[run.provider];
    if (run.ok && run.ms !== null) { pd.latencies.push(run.ms); pd.success++; }
    else { pd.error_types.push(run.error_type ?? "unknown error"); }
    const sg = geo_key(run.server_geo);
    if (sg && !pd.server_geos.includes(sg)) pd.server_geos.push(sg);
  }

  const providers = Object.entries(by_provider).map(([name, pd]) => {
    const sorted = [...pd.latencies].sort((a, b) => a - b);
    const n = pd.success + pd.error_types.length;
    // Summarise errors: count occurrences of each error type
    const error_summary = pd.error_types.reduce((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1; return acc;
    }, {});
    return {
      name,
      display_name: provider_display_name(name),
      slug: provider_slug(name),
      n_runs: n,
      runs_ok: pd.success,
      runs_error: pd.error_types.length,
      error_summary,   // e.g. { "timeout (>15000ms)": 1 }
      server_geos: pd.server_geos,
      latency_ms: sorted.length > 0 ? {
        min: sorted[0],
        p50: percentile(sorted, 50),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1]
      } : null
    };
  });

  providers.sort((a, b) => {
    if (!a.latency_ms) return 1;
    if (!b.latency_ms) return -1;
    return a.latency_ms.p50 - b.latency_ms.p50;
  });
  return providers;
}

function eval_period(runs) {
  const dates = runs.map(r => r.ts).filter(Boolean).sort();
  return { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

// --- Load data for each window ---
const now = Date.now();
const MS = { d90: 90 * 86400000, d30: 30 * 86400000, h24: 86400000 };

const all_runs  = load_runs(results_dir, 0);
const runs_90d  = all_runs.filter(r => new Date(r.ts ?? 0).getTime() >= now - MS.d90);
const runs_30d  = all_runs.filter(r => new Date(r.ts ?? 0).getTime() >= now - MS.d30);
const runs_24h  = all_runs.filter(r => new Date(r.ts ?? 0).getTime() >= now - MS.h24);

// Fallback: if window is empty use all available data (benchmark still accumulating runs)
const eff_90d = runs_90d.length ? runs_90d : all_runs;
const eff_30d = runs_30d.length ? runs_30d : all_runs;
const eff_24h = runs_24h.length ? runs_24h : all_runs;

if (!all_runs.length) { process.stderr.write("No result files found.\n"); process.exit(1); }

const stats_30d = aggregate(eff_30d);
const stats_90d = aggregate(eff_90d);
const stats_24h = aggregate(eff_24h);

// Pinger origins from 30d data
const origin_map = {};  // key → { geo, runs[] }
for (const run of eff_30d) {
  const key = geo_key(run.client_geo);
  if (!key) continue;
  if (!origin_map[key]) origin_map[key] = { geo: run.client_geo, runs: [] };
  origin_map[key].runs.push(run);
}
const pinger_locations = Object.values(origin_map).map(o => geo_short(o.geo));

// Per-provider 24h runs (for detail pages)
const runs_24h_by_provider = {};
for (const run of eff_24h) {
  if (!run.ok) continue;
  if (!runs_24h_by_provider[run.provider]) runs_24h_by_provider[run.provider] = [];
  runs_24h_by_provider[run.provider].push(run);
}

// --- File writer ---
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  process.stderr.write(`  ${path}\n`);
}

// ============================================================
// JSON + text outputs
// ============================================================

// llms.txt
write(join(out_dir, "llms.txt"),
`This site publishes a latency benchmark for remote MCP server hosting providers.
Metric: tools/list response time in milliseconds, cold start included, measured every 2 hours from multiple locations worldwide.
Machine-readable data index (providers, stats, dataset URLs): ${u("/llms.json")}
Each entry in the index contains a dataset URL and a plain-language description of its contents.
`);

// llms-full.txt
write(join(out_dir, "llms-full.txt"),
`This site publishes a latency benchmark for remote MCP server hosting providers.
Metric: tools/list response time in milliseconds, cold start included, measured every 2 hours from multiple locations worldwide.
Full dataset (all providers, aggregated stats, and individual run records from the last 24 hours): ${u("/llms-full.json")}
`);

// robots.txt
write(join(out_dir, "robots.txt"), "User-agent: *\nAllow: /\n");

// Build datasets list
const datasets = [
  {
    id: "all_origins_90d",
    description: "Aggregated latency stats (min, p50, p99, max) for all remote MCP server hosting providers. All pinger locations combined. 90-day window. Sorted by p50 ascending.",
    url: u("/llms.json")
  },
  {
    id: "all_origins_24h_with_runs",
    description: "Same aggregated stats plus individual run records from the last 24 hours. Use this to see recent raw measurements per provider.",
    url: u("/llms-full.json")
  }
];
for (const { geo } of Object.values(origin_map)) {
  datasets.push({
    id: `from_${geo_slug(geo)}`,
    description: `Aggregated latency stats filtered to measurements made from ${geo_display(geo)}. 30-day window.`,
    url: u(`/tools-list-latency-from/${geo_slug(geo)}.json`)
  });
}

function provider_json_entry(p, include_runs = false) {
  const entry = {
    name: p.display_name,
    slug: p.slug,
    server_location: server_location_display(p.server_geos),
    n_runs: p.n_runs,
    runs_ok: p.runs_ok,
    runs_error: p.runs_error,
    min_ms:  p.latency_ms?.min  ?? null,
    p50_ms:  p.latency_ms?.p50  ?? null,
    p99_ms:  p.latency_ms?.p99  ?? null,
    max_ms:  p.latency_ms?.max  ?? null
  };
  if (include_runs) {
    entry.runs = (runs_24h_by_provider[p.name] ?? [])
      .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))
      .map(r => ({ ts: r.ts, pinger: geo_display(r.client_geo), ms: r.ms }));
  }
  return entry;
}

// llms.json (90d, no individual runs)
const period_90d = eval_period(eff_90d);
write(join(out_dir, "llms.json"), JSON.stringify({
  title: "Remote MCP server hosting provider latency benchmark",
  metric: "tools/list response time in milliseconds — cold start included — measured from multiple locations worldwide",
  unit: "ms",
  measurement_cadence_hours: 2,
  evaluation_period: period_90d,
  last_updated: new Date().toISOString(),
  pinger_locations,
  datasets,
  providers: stats_90d.map(p => provider_json_entry(p, false))
}, null, 2));

// llms-full.json (24h, with individual runs)
write(join(out_dir, "llms-full.json"), JSON.stringify({
  title: "Remote MCP server hosting provider latency benchmark",
  metric: "tools/list response time in milliseconds — cold start included",
  unit: "ms",
  measurement_cadence_hours: 2,
  evaluation_period: eval_period(eff_24h),
  last_updated: new Date().toISOString(),
  pinger_locations,
  providers: stats_24h.map(p => provider_json_entry(p, true))
}, null, 2));

// Per-origin JSON files (30d, no individual runs)
for (const { geo, runs } of Object.values(origin_map)) {
  const stats = aggregate(runs);
  write(join(out_dir, "tools-list-latency-from", `${geo_slug(geo)}.json`), JSON.stringify({
    title: "Remote MCP server hosting provider latency benchmark",
    metric: "tools/list response time in milliseconds — cold start included",
    unit: "ms",
    filter: { pinger_location: geo_display(geo) },
    evaluation_period: eval_period(runs),
    last_updated: new Date().toISOString(),
    providers: stats.map(p => provider_json_entry(p, false))
  }, null, 2));
}

// ============================================================
// HTML outputs
// ============================================================

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;background:#fff;padding:14px}
h1{font-size:17px;font-weight:700;line-height:1.3;margin-bottom:4px}
.meta{font-size:11px;color:#666;margin-bottom:10px;line-height:1.6}
.origins{font-size:12px;margin-bottom:14px}
.origins a,.origins strong{margin-right:6px}
.origins a{color:#0066cc;text-decoration:none}
table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
thead tr{background:#f5f5f5}
th{padding:6px 4px;font-weight:600;font-size:11px;text-align:right;border-bottom:2px solid #ccc;vertical-align:bottom}
th:first-child{text-align:left;width:38%}
td{padding:5px 4px;border-bottom:1px solid #eee;text-align:right;vertical-align:top}
td:first-child{text-align:left}
.pname{font-weight:600;font-size:13px}
.pname a{color:#111;text-decoration:none}
.pname a:hover{text-decoration:underline}
.sloc{font-size:10px;color:#777;margin-top:1px}
.n{font-size:10px;color:#999;display:block}
.nav{margin-top:18px;font-size:12px;border-top:1px solid #eee;padding-top:10px}
.nav a{color:#0066cc;text-decoration:none;margin-right:12px}
.back{font-size:12px;margin-bottom:12px}
.back a{color:#0066cc;text-decoration:none}
.section{font-size:14px;font-weight:600;margin:18px 0 8px}
.runs-tbl th{font-size:10px;font-weight:600}
.runs-tbl td{font-size:12px}
.err{color:#c00}
.method{font-size:12px;color:#444;line-height:1.8;margin-bottom:14px;padding:10px 12px;background:#f9f9f9;border-left:3px solid #ccc}
.method a{color:#0066cc;text-decoration:none}
`.trim();

function fmt(v) { return (v === null || v === undefined) ? "—" : String(v); }

// Format error_summary as a readable string: "1 timeout (>15s)"
function fmt_errors(p) {
  if (p.runs_error === 0) return "—";
  return Object.entries(p.error_summary)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

// Methodology block displayed above the table
function methodology_block(period, measurement_locations) {
  const from = period.from ? new Date(period.from).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";
  const to   = period.to   ? new Date(period.to  ).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";
  const loc_links = measurement_locations.map(({ geo }) =>
    `<a href="${u(`/tools-list-latency-from/${geo_slug(geo)}.html`)}">${geo_display(geo)}</a>`
  ).join(" &nbsp;·&nbsp; ");

  return `<div class="method">
  <strong>What is measured:</strong> the time a remote MCP server takes to respond to a tools/list request, in milliseconds<br>
  <strong>Measurement cadence:</strong> every 2 hours<br>
  <strong>Period:</strong> ${from} – ${to}<br>
  <strong>Measured from:</strong> ${loc_links}
</div>`;
}

function summary_table(providers, provider_link = true) {
  const rows = providers.map(p => {
    const lat = p.latency_ms;
    const n   = p.n_runs;
    const loc = server_location_display(p.server_geos);
    const name_cell = provider_link
      ? `<a href="${u(`/remote-mcp-server-hosting-provider/${p.slug}.html`)}">${p.display_name}</a>`
      : p.display_name;
    const err_cell = p.runs_error > 0
      ? `<span class="err">${fmt_errors(p)}</span>`
      : "—";
    return `<tr>
      <td><div class="pname">${name_cell}</div><div class="sloc">${loc}</div></td>
      <td>${fmt(lat?.min)}</td>
      <td>${fmt(lat?.p50)}<span class="n">${n} runs</span></td>
      <td>${fmt(lat?.p99)}<span class="n">${n} runs</span></td>
      <td>${fmt(lat?.max)}</td>
      <td>${err_cell}</td>
    </tr>`;
  }).join("\n");

  return `<table>
  <thead>
  <tr>
    <th rowspan="2" scope="col" style="text-align:left;width:38%;vertical-align:bottom">Hosting provider<br><span style="font-weight:400;color:#888">Server location</span></th>
    <th colspan="4" scope="colgroup" style="text-align:center;border-bottom:1px solid #ccc;font-size:10px;font-weight:600;color:#555;padding-bottom:2px">tools/list response time</th>
    <th rowspan="2" scope="col" style="vertical-align:bottom">Failed<br><span style="font-weight:400;color:#888">runs</span></th>
  </tr>
  <tr>
    <th scope="col">Min<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">P50<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">P99<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">Max<br><span style="font-weight:400;color:#888">ms</span></th>
  </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

function origins_nav(current_slug) {
  const links = Object.values(origin_map).map(({ geo }) => {
    const slug = geo_slug(geo);
    const label = geo_short(geo);
    return slug === current_slug
      ? `<strong>${label}</strong>`
      : `<a href="${u(`/tools-list-latency-from/${slug}.html`)}">${label}</a>`;
  });
  return links.join(" · ");
}

function html_page({ title, meta_desc, jsonld, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${meta_desc}">
${jsonld ? `<script type="application/ld+json">\n${jsonld}\n</script>` : ""}
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// --- index.html ---
const period_30d = eval_period(eff_30d);
const jsonld = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Dataset",
  "name": "Remote MCP Server Hosting Provider Latency Benchmark",
  "description": "tools/list response time benchmark for remote MCP server hosting providers — cold start included — measured from multiple locations worldwide",
  "url": u("/"),
  "temporalCoverage": `${period_30d.from ?? ""}/${period_30d.to ?? ""}`,
  "measurementMethod": "Automated tools/list call every 2 hours from multiple geographic locations",
  "variableMeasured": "tools/list latency in milliseconds"
}, null, 2);


write(join(out_dir, "index.html"), html_page({
  title: "Remote MCP Server Hosting Provider Latency Benchmark",
  meta_desc: "Latency benchmark (tools/list response time) for remote MCP server hosting providers: Cloudflare Workers, Vercel, Netlify, Railway, Supabase, Fermyon, Val.town, Render. Measured from multiple locations worldwide, sorted by P50.",
  jsonld,
  body: `<h1>Remote MCP Server Hosting Provider Latency Benchmark</h1>
<p class="meta">Sorted by P50 ascending — lower is better</p>
${methodology_block(period_30d, Object.values(origin_map))}
${summary_table(stats_30d)}
<nav class="nav">
  <a href="${u('/remote-mcp-server-hosting-provider/')}">Providers</a>
  <a href="${u('/tools-list-latency-from/')}">Origins</a>
  <a href="${u('/llms.json')}">JSON (90d)</a>
  <a href="${u('/llms-full.json')}">JSON + runs (24h)</a>
</nav>`
}));

// --- Per-provider detail pages ---
for (const p of stats_30d) {
  const recent = (runs_24h_by_provider[p.name] ?? [])
    .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  const server_loc = server_location_display(p.server_geos);
  const lat = p.latency_ms;

  const runs_rows = recent.length === 0
    ? '<tr><td colspan="3" style="color:#888">No runs recorded in the last 24 hours</td></tr>'
    : recent.map(r => `<tr>
      <td>${r.ts ? r.ts.replace("T", " ").slice(0, 16) + " UTC" : "—"}</td>
      <td>${geo_display(r.client_geo)}</td>
      <td>${r.ms} ms</td>
    </tr>`).join("\n");

  write(join(out_dir, "remote-mcp-server-hosting-provider", `${p.slug}.html`), html_page({
    title: `${p.display_name} — Remote MCP Server Hosting Latency`,
    meta_desc: `tools/list response time benchmark for ${p.display_name} remote MCP server hosting. Server: ${server_loc}. Min, P50, P99, Max over the measurement period.`,
    jsonld: null,
    body: `<p class="back"><a href="${u('/')}">← Benchmark home</a></p>
<h1>${p.display_name}</h1>
<p class="meta">Remote MCP server hosting provider · Server: ${server_loc}</p>
${methodology_block(period_30d, Object.values(origin_map))}

<table>
  <thead><tr>
    <th scope="col" style="text-align:left;width:auto">Metric</th>
    <th scope="col">Min</th>
    <th scope="col">P50 (${p.n_runs} runs)</th>
    <th scope="col">P99 (${p.n_runs} runs)</th>
    <th scope="col">Max</th>
  </tr></thead>
  <tbody><tr>
    <td style="text-align:left;font-size:11px;color:#666">ms</td>
    <td>${fmt(lat?.min)}</td>
    <td>${fmt(lat?.p50)}</td>
    <td>${fmt(lat?.p99)}</td>
    <td>${fmt(lat?.max)}</td>
  </tr></tbody>
</table>

<p class="section">Last 24 hours — individual runs</p>
<table class="runs-tbl">
  <thead><tr>
    <th scope="col" style="text-align:left">Timestamp</th>
    <th scope="col" style="text-align:left">Measured from</th>
    <th scope="col">Latency</th>
  </tr></thead>
  <tbody>${runs_rows}</tbody>
</table>

<nav class="nav">
  <a href="${u('/')}">← All providers</a>
  <a href="${u('/llms.json')}">JSON data</a>
</nav>`
  }));
}

// Provider index page
const provider_index_rows = stats_30d.map(p =>
  `<li><a href="${u(`/remote-mcp-server-hosting-provider/${p.slug}.html`)}">${p.display_name}</a> — ${server_location_display(p.server_geos)}</li>`
).join("\n");

write(join(out_dir, "remote-mcp-server-hosting-provider", "index.html"), html_page({
  title: "Remote MCP Server Hosting Providers — Latency Benchmark",
  meta_desc: "List of remote MCP server hosting providers included in the latency benchmark.",
  jsonld: null,
  body: `<p class="back"><a href="${u('/')}">← Benchmark home</a></p>
<h1>Remote MCP Server Hosting Providers</h1>
<p class="meta">Click a provider to see detailed latency stats and recent runs.</p>
<ul style="margin-top:12px;line-height:2">${provider_index_rows}</ul>
<nav class="nav"><a href="${u('/')}">← Back</a></nav>`
}));

// --- Per-origin pages ---
for (const { geo, runs } of Object.values(origin_map)) {
  const stats  = aggregate(runs);
  const slug   = geo_slug(geo);
  const display = geo_display(geo);
  const period  = eval_period(runs);

  write(join(out_dir, "tools-list-latency-from", `${slug}.html`), html_page({
    title: `Remote MCP Server Hosting Latency — from ${display}`,
    meta_desc: `tools/list response time benchmark for remote MCP server hosting providers, measured from ${display}. Sorted by P50.`,
    jsonld: null,
    body: `<p class="back"><a href="${u('/')}">← Benchmark home</a></p>
<h1>Remote MCP Server Hosting Provider Latency Benchmark</h1>
<p class="meta">Sorted by P50 ascending — lower is better</p>
${methodology_block(eval_period(runs), [{ geo }])}
<p class="origins" style="margin-bottom:12px">Other measurement locations: ${origins_nav(slug)}</p>
${summary_table(stats, true)}
<nav class="nav">
  <a href="${u('/')}">All origins</a>
  <a href="${u('/llms.json')}">JSON data</a>
  <a href="${u(`/tools-list-latency-from/${slug}.json`)}">JSON (this origin)</a>
</nav>`
  }));
}

// Origins index page
const origin_index_rows = Object.values(origin_map).map(({ geo }) =>
  `<li><a href="${u(`/tools-list-latency-from/${geo_slug(geo)}.html`)}">${geo_display(geo)}</a></li>`
).join("\n");

write(join(out_dir, "tools-list-latency-from", "index.html"), html_page({
  title: "Latency by Pinger Origin — Remote MCP Server Hosting Benchmark",
  meta_desc: "Browse remote MCP server hosting provider latency results filtered by the geographic location of the measurement pinger.",
  jsonld: null,
  body: `<p class="back"><a href="${u('/')}">← Benchmark home</a></p>
<h1>Latency by Pinger Origin</h1>
<p class="meta">Select a location to see latency results measured from that geographic region.</p>
<ul style="margin-top:12px;line-height:2">${origin_index_rows}</ul>
<nav class="nav"><a href="${u('/')}">← Back</a></nav>`
}));

process.stderr.write(`\nDone. Output written to ${out_dir}\n`);
