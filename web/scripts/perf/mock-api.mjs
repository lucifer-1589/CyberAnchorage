// Deterministic mock of the CyberAnchorage API for UI perf/screenshot runs (no backend needed).
// Mirrors the contracts in src/lib/types.ts; the IOC list serves `iocCount` rows (default 100 000)
// through the real limit/offset paging, and the WebSocket pushes live events so batching is exercised.
// Synthetic data only — documentation-range IPs (RFC 5737) and .example/.test style names.

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const TYPES = ["ipv4", "domain", "url", "ip:port", "ipv4", "domain", "onion", "cidr"];
const SOURCES = ["telegram", "crawler", "connector", "ioc_hunter"];
const TAGS = ["c2", "phishing", "botnet", "loader", "scanner", "tor-exit", "ransomware", "infostealer"];
const MALWARE = ["LummaC2", "AsyncRAT", "Cobalt Strike", "QakBot", "RedLine", "Sliver"];
const ACTORS = ["FIN7", "TA505", "Scattered Spider", "APT28"];
const TLPS = ["AMBER", "AMBER", "GREEN", "CLEAR", "RED", "AMBER+STRICT"];
const WORDS = ["update", "cdn", "auth", "sync", "mail", "pay", "cloud", "secure", "api", "login", "files", "panel"];
const TLD = ["example", "test", "invalid"];

export function makeIocs(n) {
  const R = rng(42);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const type = TYPES[i % TYPES.length];
    const ip = () => `${pick(["192.0.2", "198.51.100", "203.0.113"])}.${1 + Math.floor(R() * 253)}`;
    const host = `${pick(WORDS)}-${pick(WORDS)}${i % 97}.${pick(TLD)}`;
    const value =
      type === "ipv4" ? ip().replace(/\./g, "[.]")
      : type === "ip:port" ? `${ip().replace(/\./g, "[.]")}:${pick([443, 4444, 8080, 1337, 9001])}`
      : type === "cidr" ? `${pick(["192.0.2", "198.51.100", "203.0.113"])}[.]0/24`
      : type === "url" ? `hxxps://${host.replace(/\./g, "[.]")}/${pick(WORDS)}/${Math.floor(R() * 1e6).toString(36)}`
      : type === "onion" ? `${Math.floor(R() * 1e15).toString(36)}${Math.floor(R() * 1e15).toString(36)}[.]onion`
      : host.replace(/\./g, "[.]");
    const score = Math.round(R() * 100) / 100;
    const verdict = score > 0.85 ? "malicious" : score > 0.65 ? "suspicious" : score > 0.5 ? "abnormal" : null;
    const severity = verdict === "malicious" ? pick(["critical", "high"]) : verdict === "suspicious" ? pick(["high", "medium"]) : verdict ? "medium" : null;
    const srcs = SOURCES.filter(() => R() > 0.55);
    if (!srcs.length) srcs.push(pick(SOURCES));
    const last = NOW - Math.floor(R() * 30 * DAY);
    out[i] = {
      id: i + 1, type, value, sources: srcs, source_count: srcs.length,
      first_seen: iso(last - Math.floor(R() * 60 * DAY)), last_seen: iso(last),
      tlp: pick(TLPS), score, confidence: Math.round(R() * 100) / 100,
      tags: TAGS.filter(() => R() > 0.8), malware_families: R() > 0.7 ? [pick(MALWARE)] : [], actors: R() > 0.85 ? [pick(ACTORS)] : [],
      mitre_ids: R() > 0.8 ? ["T1071.001"] : [], status: "active", expires_at: iso(last + 90 * DAY),
      allowlisted: R() > 0.985, verdict, severity, port: type === "ip:port" ? 4444 : null, asn: null, is_demo: i % 9 === 0,
    };
  }
  return out;
}

const FIELDS = (() => {
  const NUM = ["eq", "neq", "gt", "gte", "lt", "lte", "between"], AGE = ["gt", "gte", "lt", "lte", "between"], ARR = ["has_any", "has_all", "has_none"];
  const VAL = ["equals", "in", "not_in", "in_cidr", "domain_suffix", "wildcard", "regex", "contains", "starts_with", "ends_with"];
  const f = (name, label, kind, operators, extra = {}) => ({ name, label, kind, operators, help: "", options: [], min: null, max: null, ...extra });
  return [
    f("type", "IOC type", "enum", ["eq", "neq", "in", "not_in"], { options: ["ipv4", "ipv6", "cidr", "domain", "url", "ip:port", "onion", "asn", "ja3", "ja3s"] }),
    f("value", "Value", "value", VAL, { help: "Normalized IOC value. in_cidr matches IPs/networks; domain_suffix matches the host and subdomains." }),
    f("source", "Source", "array", ARR, { help: "CTI source names, e.g. telegram, crawler" }),
    f("source_count", "Source count", "number", NUM, { min: 0, max: 1000 }),
    f("confidence", "Confidence (0-1)", "number", NUM, { min: 0, max: 1 }),
    f("score", "Score (0-1)", "number", NUM, { min: 0, max: 1 }),
    f("tags", "Tags", "array", ARR),
    f("malware_family", "Malware family", "array", ARR),
    f("actor", "Threat actor", "array", ARR),
    f("mitre", "MITRE ATT&CK id", "array", ARR),
    f("first_seen_age_days", "First seen (days ago)", "age", AGE, { min: 0, max: 36500 }),
    f("last_seen_age_days", "Last seen (days ago)", "age", AGE, { min: 0, max: 36500 }),
    f("tlp", "TLP", "tlp", ["eq", "neq", "in", "gte", "lte"], { options: ["CLEAR", "GREEN", "AMBER", "AMBER+STRICT", "RED"] }),
    f("port", "Port", "number", [...NUM, "in", "not_in"], { min: 0, max: 65535 }),
    f("asn", "ASN", "int_set", ["eq", "neq", "in", "not_in"]),
  ];
})();

const RULES = [
  { name: "Tor exit infrastructure", description: "Onion services and tor-exit tagged IPs seen in 2+ sources", verdict: "malicious", severity: "critical",
    condition: { op: "and", children: [{ field: "tags", operator: "has_any", value: ["tor-exit"] }, { field: "source_count", operator: "gte", value: 2 }] } },
  { name: "Known C2 on non-standard ports", description: "ip:port IOCs on 4444/1337/9001 tagged c2", verdict: "malicious", severity: "high",
    condition: { op: "and", children: [{ field: "type", operator: "in", value: ["ip:port"] }, { field: "port", operator: "in", value: [4444, 1337, 9001] }, { op: "or", children: [{ field: "tags", operator: "has_any", value: ["c2"] }, { field: "malware_family", operator: "has_any", value: ["Cobalt Strike", "Sliver"] }] }] } },
  { name: "Phishing kits on fresh domains", description: "Domains first seen < 7 days with phishing tags", verdict: "suspicious", severity: "medium",
    condition: { op: "and", children: [{ field: "type", operator: "in", value: ["domain", "url"] }, { field: "first_seen_age_days", operator: "lt", value: 7 }, { field: "tags", operator: "has_any", value: ["phishing"] }] } },
  { name: "Low-confidence single-source", description: "Single source, confidence under 0.3", verdict: "abnormal", severity: "low",
    condition: { op: "and", children: [{ field: "source_count", operator: "eq", value: 1 }, { field: "confidence", operator: "lt", value: 0.3 }] } },
].map((r, i) => ({ id: i + 1, enabled: i !== 3, priority: 100 - i * 10, expires_at: null, version: 3 - (i % 2), is_demo: i === 3,
  created_at: iso(NOW - 40 * DAY), updated_at: iso(NOW - (i + 1) * DAY), last_evaluated_at: iso(NOW - 3600_000 * (i + 1)), match_count: [1240, 862, 3880, 612][i], ...r }));

function facet(rows, key) {
  const m = new Map();
  for (const r of rows) for (const k of [].concat(r[key] ?? "none")) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].map(([k, count]) => ({ key: String(k), count })).sort((a, b) => b.count - a.count).slice(0, 12);
}

export async function installMockApi(page, { iocCount = 100_000, liveEveryMs = 1500, role = "admin" } = {}) {
  const IOCS = makeIocs(iocCount);
  const byId = new Map(IOCS.map((i) => [i.id, i]));
  const user = { id: 1, email: "analyst@cyberanchorage.test", name: "Ada Analyst", role, is_active: true };
  const runs = Array.from({ length: 12 }, (_, i) => ({
    id: 300 - i, kind: i % 6 === 0 ? "full" : "incremental", mode: i % 6 === 0 ? "reconcile" : "incremental",
    status: i === 4 ? "partial" : i === 9 ? "failed" : "success", triggered_by: i ? "schedule" : "analyst@cyberanchorage.test",
    queued_at: iso(NOW - i * 3600_000 - 60_000), started_at: iso(NOW - i * 3600_000 - 50_000), finished_at: iso(NOW - i * 3600_000),
    heartbeat_at: iso(NOW - i * 3600_000), new: 120 + ((i * 37) % 300), updated: 800 + ((i * 91) % 900), unchanged: 98000, expired: 12 + i, rejected: 3, skipped: 0,
    flagged: 40 + i * 3, errors: i === 9 ? [{ source: "telegram", error: "snapshot locked, retrying next cycle" }] : [], stats: {},
  }));
  const overview = {
    totals: { active: iocCount, all: iocCount + 4210, new_24h: 1318, flagged: 18420, allowlisted: 1502, rules_enabled: 3, detections_24h: 318, demo: Math.ceil(iocCount / 9) },
    by_type: facet(IOCS, "type"), by_source: facet(IOCS, "sources"),
    by_verdict: facet(IOCS.filter((i) => i.verdict), "verdict"), by_severity: facet(IOCS.filter((i) => i.severity), "severity"),
    top_malware: facet(IOCS, "malware_families").filter((f) => f.key !== "none").slice(0, 6), top_actors: facet(IOCS, "actors").filter((f) => f.key !== "none").slice(0, 6),
    timeline: Array.from({ length: 30 }, (_, d) => ({ date: iso(NOW - (29 - d) * DAY).slice(0, 10), ingested: 900 + Math.round(400 * Math.sin(d / 3) + d * 18), flagged: 120 + Math.round(60 * Math.cos(d / 4) + d * 4) })),
    sync: { last_run: runs[0], last_success_at: runs[0].finished_at, recent: runs.slice(0, 12), worker: { heartbeat_at: iso(NOW), jobs: { incremental: { name: "incremental", next_run_at: iso(NOW + 3600_000) }, reconcile: { name: "reconcile", next_run_at: iso(NOW + 19 * 3600_000) } } } },
  };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api/, "");
    const q = url.searchParams;
    const method = route.request().method();
    if (p === "/auth/refresh" || p === "/auth/login") return json(route, { access_token: "mock-token", user });
    if (p === "/stats/overview") return json(route, overview);
    if (p === "/iocs") {
      let rows = IOCS;
      const needle = (q.get("q") ?? "").replace(/\[\.\]/g, ".").toLowerCase();
      if (needle) rows = rows.filter((r) => r.value.replace(/\[\.\]/g, ".").toLowerCase().includes(needle));
      for (const k of ["type", "verdict", "severity"]) { const v = q.getAll(k); if (v.length) rows = rows.filter((r) => v.includes(String(r[k] ?? "none"))); }
      const limit = Number(q.get("limit") ?? 100), offset = Number(q.get("offset") ?? 0);
      return json(route, { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
    }
    if (p === "/iocs/facets") return json(route, { type: facet(IOCS, "type"), verdict: facet(IOCS, "verdict"), severity: facet(IOCS, "severity"), source: facet(IOCS, "sources"), tag: facet(IOCS, "tags"), tlp: facet(IOCS, "tlp") });
    let m;
    if ((m = p.match(/^\/iocs\/(\d+)$/))) {
      const ioc = byId.get(Number(m[1]));
      return json(route, { ioc, detections: ioc.id % 5,
        source_refs: ioc.sources.map((s, i) => ({ k: `${s}:${ioc.id}:${i}`, source: s, title: `${s} sighting`, url: null, first_seen: ioc.first_seen, last_seen: ioc.last_seen, channels: [], sightings: 1 + i, severity: null, messages: [] })),
        flags: ioc.verdict ? [{ rule_id: 1, rule_name: RULES[0].name, rule_version: 3, current_rule_version: 3, verdict: ioc.verdict, severity: ioc.severity, ts: ioc.last_seen }] : [] });
    }
    if (p === "/views") return json(route, method === "GET" ? [{ id: 1, name: "Critical C2, last 24 h", filters: { verdict: ["malicious"], new_within_hours: "24" } }] : { id: 2 });
    if (p === "/rules/fields") return json(route, { fields: FIELDS, verdicts: ["abnormal", "suspicious", "malicious"], severities: ["low", "medium", "high", "critical"] });
    if (p === "/rules") return json(route, RULES);
    if ((m = p.match(/^\/rules\/(\d+)$/))) return json(route, RULES[Number(m[1]) - 1]);
    if ((m = p.match(/^\/rules\/(\d+)\/versions$/))) return json(route, [3, 2, 1].map((v) => ({ version: v, snapshot: {}, changed_by_email: user.email, change_note: v === 3 ? "tighten source_count" : "", changed_at: iso(NOW - v * DAY) })));
    if ((m = p.match(/^\/rules\/(\d+)\/toggle$/))) return json(route, { ...RULES[Number(m[1]) - 1], enabled: JSON.parse(route.request().postData() ?? "{}").enabled });
    if (p === "/rules/dry-run") return json(route, { count: 1240, allowlisted: 18, samples: IOCS.filter((i) => i.score > 0.85).slice(0, 8) }); // DryRunOut
    if (p === "/sync/status") return json(route, {
      sources: SOURCES.map((s, i) => ({ source: s, store: `${s}.db`, path: `darkweb_intel/${s}.db`, ok: i !== 3, detail: i === 3 ? "snapshot older than 26 h" : "ok", rows: 25000 + i * 3100, size_bytes: (40 + i * 12) * 1e6, modified_at: iso(NOW - i * 3600_000), is_demo: false })),
      cursors: SOURCES.map((s, i) => ({ source_key: s, max_rowid: 25000 + i * 3100, max_last_seen: iso(NOW - i * 3600_000), updated_at: iso(NOW - i * 3600_000) })),
      worker: overview.sync.worker && { alive: true, ...overview.sync.worker }, current: [] });
    if (p === "/sync/runs") return json(route, { items: runs, total: runs.length });
    if (p === "/search") { const s = (q.get("q") ?? "").toLowerCase(); return json(route, { iocs: IOCS.filter((i) => i.value.includes(s)).slice(0, 6), rules: RULES.filter((r) => r.name.toLowerCase().includes(s)) }); }
    if (p === "/flags") return json(route, { items: IOCS.filter((i) => i.verdict).slice(0, 50).map((i) => ({ ioc: i, rule_id: 1, rule_name: RULES[0].name, verdict: i.verdict, severity: i.severity, ts: i.last_seen })), total: 18420, limit: 50, offset: 0 });
    if (p === "/detections") return json(route, { items: [], total: 0, limit: 50, offset: 0 });
    if (p === "/realtime/status") return json(route, { event_source: "simulator", simulator: true, index: { exact: 90000, cidr: 1200, suffix: 8800, rules: 3, built_at: iso(NOW), build_ms: 412 } });
    if (p === "/allowlist") return json(route, method === "GET" ? { items: [], total: 0, limit: 50, offset: 0 } : {});
    if (p === "/audit") return json(route, { items: [], total: 0, limit: 100, offset: 0 });
    if (p === "/users") return json(route, [user]);
    if (p === "/settings") return json(route, {});
    return json(route, {});
  });

  // Live events: a steady trickle so the batcher and live dot are exercised.
  await page.routeWebSocket("**/api/ws**", (ws) => {
    let n = 0;
    const t = setInterval(() => {
      n++;
      try {
        ws.send(JSON.stringify({ type: n % 4 === 0 ? "flags.updated" : "detection.created", ts: new Date().toISOString(), data: { new_flags: n % 4 === 0 ? 2 : 0, id: n } }));
      } catch { clearInterval(t); }
    }, liveEveryMs);
    t.unref?.(); // never keep the Node process alive after the browser closes
    ws.onClose(() => clearInterval(t));
  });
  return { iocs: IOCS, user };
}
