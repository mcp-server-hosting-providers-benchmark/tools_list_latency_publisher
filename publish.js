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
// Full absolute URL of the published site (used in LLM prompt links)
const SITE_URL      = (flag("--site")      ?? "https://mcp-server-hosting-providers-benchmark.github.io/tools_list_latency_publisher").replace(/\/$/, "");
// Optional analytics endpoint for click tracking (e.g. a Cloudflare Worker).
// If provided, a small inline script fires navigator.sendBeacon() on every [data-track] click.
const ANALYTICS_URL = flag("--analytics") ?? null;

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
  AE:"UAE", IL:"Israel", US:"United States", VN:"Vietnam", ZA:"South Africa"
};
const country_name = (iso) => COUNTRY_NAMES[iso] ?? iso;

// Geo statique par pinger label (nom du dossier GCS).
// Utilisé à la place de la résolution IP dynamique, supprimée des pingers GCR.
const LABEL_GEO = {
  sydney_au:       { city: "Sydney",        country: "Australia",     country_code: "AU" },
  virginia_us:     { city: "Ashburn",       country: "United States", country_code: "US" },
  oregon_us:       { city: "The Dalles",    country: "United States", country_code: "US" },
  paris_fr:        { city: "Paris",         country: "France",        country_code: "FR" },
  warsaw_pl:       { city: "Warsaw",        country: "Poland",        country_code: "PL" },
  tokyo_jp:        { city: "Tokyo",         country: "Japan",         country_code: "JP" },
  singapore_sg:    { city: "Singapore",     country: "Singapore",     country_code: "SG" },
  mumbai_in:       { city: "Mumbai",        country: "India",         country_code: "IN" },
  sao_paulo_br:    { city: "São Paulo",     country: "Brazil",        country_code: "BR" },
  tel_aviv_il:     { city: "Tel Aviv",      country: "Israel",        country_code: "IL" },
  johannesburg_za: { city: "Johannesburg",  country: "South Africa",  country_code: "ZA" },
  hong_kong_hk:    { city: "Hong Kong",     country: "Hong Kong",     country_code: "HK" },
};

function get_client_geo(data, file_path) {
  const label = data.server_label ?? null;
  if (label && LABEL_GEO[label]) return LABEL_GEO[label];
  // Fallback : inférer depuis le nom du dossier parent
  const folder = file_path ? file_path.split("/").slice(-2, -1)[0] : null;
  if (folder && LABEL_GEO[folder]) return LABEL_GEO[folder];
  // Dernier recours : geo enregistrée dans le fichier (anciens runs MacBook)
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

// --- Pinger platform helpers ---
// Traduit pinger_source_url en nom lisible.
// undefined → null (champ absent, vieux fichier — ne pas afficher)
// null      → "Local machine" (Mac local, champ présent mais vide)
// URL       → "GitHub Actions" / "GitLab CI" / domaine brut
function pinger_platform(source_url) {
  if (source_url === undefined) return null;
  if (source_url === null) return "Local machine";
  try {
    const host = new URL(source_url).hostname;
    if (host === "github.com") return "GitHub Actions";
    if (host === "gitlab.com") return "GitLab CI";
    return host;
  } catch { return null; }
}

// --- Provider display helpers ---
function provider_display_name(internal_name) {
  return internal_name.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function provider_slug(internal_name) {
  return internal_name.replace(/_/g, "-");
}

// --- Collecte récursive des fichiers résultats (supporte sous-dossiers par région) ---
function collect_result_files(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...collect_result_files(join(dir, entry.name)));
    } else if (entry.name.startsWith("tools_list_") && entry.name.endsWith(".json")) {
      files.push(join(dir, entry.name));
    }
  }
  return files.sort();
}

// --- Load runs from result files ---
function load_runs(dir, since_ms = 0) {
  const files = collect_result_files(dir);

  const runs = [];
  for (const file of files) {
    let data;
    try { data = JSON.parse(readFileSync(file, "utf-8")); }
    catch { continue; }

    const ts = new Date(data.date ?? 0).getTime();
    if (ts < since_ms) continue;

    const client_geo = get_client_geo(data, file);
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
        server_geo: get_server_geo(r),
        // undefined = champ absent (vieux fichier, plateforme inconnue)
        // null      = champ présent mais vide (Mac local, intentionnel)
        // string    = URL CI (GitHub Actions, GitLab CI...)
        pinger_source_url: "pinger_source_url" in data ? data.pinger_source_url : undefined,
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
        p95: percentile(sorted, 95),
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

if (!all_runs.length) {
  const empty_html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Remote MCP Server Hosting Provider Latency Benchmark</title></head><body><h1>Remote MCP Server Hosting Provider Latency Benchmark</h1><p>Data collection in progress — first results expected within 6 hours.</p></body></html>`;
  writeFileSync(join(out_dir, "index.html"), empty_html);
  process.stderr.write("No result files found — wrote placeholder index.html.\n");
  process.exit(0);
}

const stats_30d = aggregate(eff_30d);
const stats_90d = aggregate(eff_90d);
const stats_24h = aggregate(eff_24h);

// Pinger origins from 30d data
const origin_map = {};  // key → { geo, runs[] }
for (const run of eff_30d) {
  const key = geo_key(run.client_geo);
  if (!key) continue;
  if (!origin_map[key]) origin_map[key] = { geo: run.client_geo, runs: [], pinger_source_url: undefined };
  // Garder la première valeur connue (null = Mac intentionnel, string = CI)
  if (origin_map[key].pinger_source_url === undefined && run.pinger_source_url !== undefined) {
    origin_map[key].pinger_source_url = run.pinger_source_url;
  }
  origin_map[key].runs.push(run);
}
const pinger_locations = Object.values(origin_map).map(o => ({
  location: geo_display(o.geo),
  platform: pinger_platform(o.pinger_source_url),
  source_url: o.pinger_source_url ?? null,
}));

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

// llms-narrative.txt — même données que llms-full.json mais en prose
// Sert de contre-exemple pour comparer la qualité d'analyse LLM entre .txt et .json
{
  const period = eval_period(eff_24h);
  const from_s = period.from ? new Date(period.from).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";
  const to_s   = period.to   ? new Date(period.to  ).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";

  const pingers_txt = pinger_locations
    .map(pl => `- ${pl.location}${pl.platform ? ` (${pl.platform})` : ""}`)
    .join("\n");

  const providers_txt = stats_24h.map((p, i) => {
    const l = p.latency_ms;
    const loc = server_location_display(p.server_geos);
    const runs_txt = (runs_24h_by_provider[p.name] ?? [])
      .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))
      .slice(0, 5)
      .map(r => `  - ${r.ts ? r.ts.replace("T"," ").slice(0,16)+" UTC" : "?"} from ${geo_display(r.client_geo)}: ${r.ms}ms`)
      .join("\n");
    const stats_line = l
      ? `min=${l.min}ms  P50=${l.p50}ms  P95=${l.p95}ms  P99=${l.p99}ms  max=${l.max}ms`
      : "no successful runs";
    const errors_line = p.runs_error > 0
      ? `\nTimeouts/errors: ${p.runs_error} (${Object.entries(p.error_summary).map(([t,c])=>`${c}x ${t}`).join(", ")})`
      : "";
    return `### ${i+1}. ${p.display_name}\nServer location: ${loc}\nTotal runs: ${p.n_runs} (${p.runs_ok} ok${p.runs_error ? `, ${p.runs_error} errors` : ""})\nLatency: ${stats_line}${errors_line}${runs_txt ? `\nRecent runs (last 24h):\n${runs_txt}` : ""}`;
  }).join("\n\n");

  write(join(out_dir, "llms-narrative.txt"),
`# Remote MCP Server Hosting Provider Latency Benchmark

Source: ${SITE_URL}
Last updated: ${new Date().toISOString()}
Evaluation period: ${from_s} – ${to_s}
Measurement cadence: every 2 hours

## What is measured

tools/list response time in milliseconds — from the moment the MCP client sends the HTTP request to the moment it receives the complete response from the remote MCP server. Cold start is included (the server may need to spin up before responding).

## What is NOT measured

Warm-start latency, individual tool call latency, server availability, performance under load, or the MCP server's own execution logic. All providers run the same identical MCP server — latency differences reflect hosting infrastructure only.

## Measurement locations (pingers)

${pingers_txt}

## Results (sorted by P50 ascending)

${providers_txt}

## Percentile definitions

P50 (median): half of all runs were faster than this value. Reflects typical performance.
P95: 95% of runs were faster. 1 in 20 users experiences a wait longer than this.
P99: 99% of runs were faster. 1 in 100 users experiences a wait longer than this. Reveals worst-case spikes.
`);
}

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
    p95_ms:  p.latency_ms?.p95  ?? null,
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
.footer{font-size:11px;color:#999;margin-top:24px;padding-top:10px;border-top:1px solid #eee;line-height:1.8}
.footer a{color:#999;text-decoration:none}
.footer a:hover{text-decoration:underline}
.llm-cta{font-size:12px;color:#444;margin:10px 0 14px;line-height:2}
.llm-cta a{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:4px;text-decoration:none;font-weight:600;font-size:11px}
.llm-cta a.claude{background:#d97706;color:#fff}
.llm-cta a.chatgpt{background:#10a37f;color:#fff}
.llm-cta a.claude-txt{background:transparent;border:1px solid #d97706;color:#d97706}
.llm-cta a.chatgpt-txt{background:transparent;border:1px solid #10a37f;color:#10a37f}
.llm-cta a:hover{opacity:0.75}
.llm-cta .fmt{font-size:10px;color:#999;margin-left:4px}
`.trim();

function fmt(v) { return (v === null || v === undefined) ? "—" : String(v); }

// LLM analysis CTA — prompt pré-rempli, l'utilisateur choisit quand l'envoyer
// Deux lignes : JSON (filled) et Text (outline) pour permettre la comparaison directe.
function llm_cta_block() {
  const prompt_json = `Fetch and analyze this remote MCP server hosting provider latency benchmark: ${SITE_URL}/llms.json\nWhich provider would you recommend and why? Answer in my language.`;
  const prompt_txt  = `Fetch and analyze this remote MCP server hosting provider latency benchmark: ${SITE_URL}/llms-narrative.txt\nWhich provider would you recommend and why? Answer in my language.`;
  const enc_json = encodeURIComponent(prompt_json);
  const enc_txt  = encodeURIComponent(prompt_txt);
  const globe = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
  return `<p class="llm-cta">${globe} Analyser &middot; Analyze &middot; Analizar<br>
  <span class="fmt">JSON</span>
  <a class="claude"      href="https://claude.ai/new?q=${enc_json}"  target="_blank" rel="noopener" data-track="cta-claude-json">Claude</a>
  <a class="chatgpt"     href="https://chatgpt.com/?q=${enc_json}"   target="_blank" rel="noopener" data-track="cta-chatgpt-json">ChatGPT</a>
  &nbsp;&nbsp;<span class="fmt">Text</span>
  <a class="claude-txt"  href="https://claude.ai/new?q=${enc_txt}"   target="_blank" rel="noopener" data-track="cta-claude-txt">Claude</a>
  <a class="chatgpt-txt" href="https://chatgpt.com/?q=${enc_txt}"    target="_blank" rel="noopener" data-track="cta-chatgpt-txt">ChatGPT</a>
</p>`;
}

// Format error_summary as a readable string: "1 timeout (>15s)"
function fmt_errors(p) {
  if (p.runs_error === 0) return "—";
  return Object.entries(p.error_summary)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

// Methodology block displayed below the table
function methodology_block(period, measurement_locations) {
  const from = period.from ? new Date(period.from).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";
  const to   = period.to   ? new Date(period.to  ).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "?";
  const loc_links = measurement_locations.map(({ geo, pinger_source_url }) => {
    const platform = pinger_platform(pinger_source_url);
    const label = platform
      ? `${geo_display(geo)} <span style="font-weight:400;color:#888">(${platform})</span>`
      : geo_display(geo);
    return `<a href="${u(`/tools-list-latency-from/${geo_slug(geo)}.html`)}">${label}</a>`;
  }).join(" &nbsp;·&nbsp; ");

  return `<div class="method">
  <strong>Method:</strong> the same remote MCP server is deployed unchanged on each hosting provider. Observed latency differences reflect the hosting infrastructure, not the server logic.<br>
  <strong>Metric:</strong> tools/list response time in milliseconds — from the moment the MCP client sends the HTTP request to the moment it receives the response from the remote MCP server. Cold start included.<br>
  <strong>Period:</strong> ${from} – ${to} &nbsp;·&nbsp; <strong>Cadence:</strong> every 2 hours<br>
  <strong>Measured from:</strong> ${loc_links}<br>
  <strong>P50</strong> — median: half of all runs were faster than this value. Reflects typical performance.<br>
  <strong>P95</strong> — 95th percentile: 95% of runs were faster. 1 in 20 users experiences a wait longer than this.<br>
  <strong>P99</strong> — 99th percentile: 99% of runs were faster. 1 in 100 users experiences a wait longer than this. Reveals tail latency and worst-case spikes.<br>
  <strong>What this benchmark does not measure:</strong> warm-start latency, tool call latency, availability, performance under load, or the remote MCP server's own execution performance (the benchmark isolates hosting infrastructure, not server logic).
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
      <td>${fmt(lat?.p95)}<span class="n">${n} runs</span></td>
      <td>${fmt(lat?.p99)}<span class="n">${n} runs</span></td>
      <td>${fmt(lat?.max)}</td>
      <td>${err_cell}</td>
    </tr>`;
  }).join("\n");

  return `<table>
  <thead>
  <tr>
    <th scope="col" style="text-align:left;width:38%">Hosting provider<br><span style="font-weight:400;color:#888">Server location</span></th>
    <th scope="col">Min<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">P50<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">P95<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">P99<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">Max<br><span style="font-weight:400;color:#888">ms</span></th>
    <th scope="col">Timeout<br><span style="font-weight:400;color:#888">runs</span></th>
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

const TRACKING_SCRIPT = ANALYTICS_URL
  ? `<script>document.querySelectorAll('[data-track]').forEach(function(el){el.addEventListener('click',function(){try{navigator.sendBeacon('${ANALYTICS_URL}',JSON.stringify({event:el.dataset.track,page:location.pathname,ts:Date.now()}))}catch(e){}});});</script>`
  : "";

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
<div class="footer">
  <a href="https://github.com/mcp-server-hosting-providers-benchmark" target="_blank" rel="noopener">View source on GitHub</a>
  &nbsp;·&nbsp; <a href="https://github.com/mcp-server-hosting-providers-benchmark/tools_list_latency_measurer/issues" target="_blank" rel="noopener">Report an issue</a>
</div>
${TRACKING_SCRIPT}
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
  "measurementMethod": "Automated tools/list request every 2 hours from multiple geographic locations",
  "variableMeasured": "tools/list latency in milliseconds"
}, null, 2);


write(join(out_dir, "index.html"), html_page({
  title: "Remote MCP Server Hosting Provider Latency Benchmark",
  meta_desc: "Latency benchmark (tools/list response time) for remote MCP server hosting providers: Cloudflare Workers, Vercel, Netlify, Railway, Supabase, Fermyon, Val.town, Render. Measured from multiple locations worldwide, sorted by P50.",
  jsonld,
  body: `<h1>Remote MCP Server Hosting Provider Latency Benchmark</h1>
${llm_cta_block()}
${summary_table(stats_30d)}
${methodology_block(period_30d, Object.values(origin_map))}
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

<table>
  <thead><tr>
    <th scope="col" style="text-align:left;width:auto">Metric</th>
    <th scope="col">Min</th>
    <th scope="col">P50 (${p.n_runs} runs)</th>
    <th scope="col">P95 (${p.n_runs} runs)</th>
    <th scope="col">P99 (${p.n_runs} runs)</th>
    <th scope="col">Max</th>
  </tr></thead>
  <tbody><tr>
    <td style="text-align:left;font-size:11px;color:#666">ms</td>
    <td>${fmt(lat?.min)}</td>
    <td>${fmt(lat?.p50)}</td>
    <td>${fmt(lat?.p95)}</td>
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

${methodology_block(period_30d, Object.values(origin_map))}
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
<ul style="margin-top:12px;line-height:2;padding-left:18px">${provider_index_rows}</ul>
<nav class="nav"><a href="${u('/')}">← Back</a></nav>`
}));

// --- Per-origin pages ---
for (const { geo, runs, pinger_source_url } of Object.values(origin_map)) {
  const stats    = aggregate(runs);
  const slug     = geo_slug(geo);
  const display  = geo_display(geo);
  const platform = pinger_platform(pinger_source_url);
  const period   = eval_period(runs);

  write(join(out_dir, "tools-list-latency-from", `${slug}.html`), html_page({
    title: `Remote MCP Server Hosting Latency — from ${display}`,
    meta_desc: `tools/list response time benchmark for remote MCP server hosting providers, measured from ${display}.`,
    jsonld: null,
    body: `<p class="back"><a href="${u('/')}">← Benchmark home</a></p>
<h1>Remote MCP Server Hosting Provider Latency Benchmark</h1>
<p class="meta">Measured from: <strong>${display}</strong>${platform ? ` &nbsp;·&nbsp; ${platform}` : ""}</p>
<p class="origins" style="margin-bottom:12px">Other measurement locations: ${origins_nav(slug)}</p>
${summary_table(stats, true)}
${methodology_block(period, [{ geo, pinger_source_url }])}
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
<ul style="margin-top:12px;line-height:2;padding-left:18px">${origin_index_rows}</ul>
<nav class="nav"><a href="${u('/')}">← Back</a></nav>`
}));

process.stderr.write(`\nDone. Output written to ${out_dir}\n`);
