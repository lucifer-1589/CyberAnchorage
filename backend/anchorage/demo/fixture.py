"""Generate a fixture CTI data dir (same layout + DDL as the real CTI) filled with fake IOCs.

Everything here is synthetic and is ingested as `demo:*` sources with `is_demo=true`.
This module only ever writes inside the demo directory it is given.
"""

from __future__ import annotations

import json
import random
import shutil
import sqlite3
import string
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

# DDL copied from the real CTI stores (inspected 2026-11-16) so readers run against true schemas.
CRAWLER_DDL = """
CREATE TABLE iocs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ioc_type TEXT, value TEXT, context TEXT,
    source_url TEXT, source_title TEXT,
    confidence TEXT DEFAULT 'MEDIUM', tlp TEXT DEFAULT 'WHITE',
    first_seen TEXT, last_seen TEXT, tags TEXT DEFAULT '',
    origin TEXT DEFAULT 'darkweb', raw_json TEXT DEFAULT '{}', score INTEGER DEFAULT 30,
    severity TEXT DEFAULT 'MEDIUM', subtype TEXT DEFAULT 'GENERAL', sightings INTEGER DEFAULT 1,
    analyst_note TEXT DEFAULT '',
    UNIQUE(ioc_type, value)
);
CREATE INDEX idx_iocs_last_seen ON iocs(last_seen DESC, id DESC);
"""
HUNTER_DDL = """
CREATE TABLE iocs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT, ioc_type TEXT, value TEXT, normalized TEXT,
    confidence TEXT DEFAULT 'MEDIUM', category TEXT, description TEXT,
    threat_context TEXT, tags TEXT, source_url TEXT,
    source_title TEXT, source_domain TEXT, extracted_at TEXT
);
CREATE TABLE ttp_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT, group_name TEXT, ttp TEXT, tactic TEXT,
    technique_name TEXT, procedure TEXT, platform TEXT,
    ransomware_family TEXT, source_url TEXT,
    source_title TEXT, source_domain TEXT, extracted_at TEXT
);
CREATE TABLE malware_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT, malware_name TEXT, malware_type TEXT,
    apt_group TEXT, source_url TEXT, source_title TEXT,
    source_domain TEXT, context TEXT, extracted_at TEXT
);
"""
TELEGRAM_DDL = """
CREATE TABLE channels (
    channel_id TEXT PRIMARY KEY, channel_name TEXT, last_message_id INTEGER DEFAULT 0,
    first_seen TEXT, last_seen TEXT, messages_seen INTEGER DEFAULT 0,
    messages_kept INTEGER DEFAULT 0, ioc_total INTEGER DEFAULT 0
);
CREATE TABLE iocs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ioc_type TEXT NOT NULL, ioc_value TEXT NOT NULL, defanged TEXT,
    confidence TEXT DEFAULT 'medium', first_seen TEXT, last_seen TEXT,
    sightings INTEGER DEFAULT 1, channels TEXT, channel_count INTEGER DEFAULT 1,
    severity TEXT, categories TEXT, malware_fams TEXT,
    UNIQUE(ioc_type, ioc_value)
);
CREATE TABLE ioc_sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ioc_id INTEGER NOT NULL, channel_id TEXT, channel_name TEXT, message_id INTEGER,
    date TEXT, confidence TEXT, context TEXT,
    UNIQUE(ioc_id, channel_id, message_id),
    FOREIGN KEY(ioc_id) REFERENCES iocs(id) ON DELETE CASCADE
);
"""
CORE_DDL = """
CREATE TABLE apts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT UNIQUE, aliases TEXT, nation_state TEXT,
    targeted_sectors TEXT, targeted_countries TEXT,
    malware_families TEXT, ttps TEXT, last_activity TEXT,
    iocs TEXT, source_url TEXT, confidence TEXT, first_seen TEXT
);
"""

FAMILIES = {
    "LockBit": ("LockBit Gang", ["T1486", "T1490", "T1078"]),
    "Clop": ("FIN11", ["T1190", "T1486", "T1567"]),
    "BlackCat": ("ALPHV", ["T1486", "T1059", "T1021"]),
    "Qakbot": ("TA570", ["T1566", "T1055", "T1071"]),
    "Cobalt Strike": ("Multiple", ["T1071", "T1055", "T1105"]),
    "RedLine": ("Unattributed", ["T1555", "T1005", "T1041"]),
    "Emotet": ("TA542", ["T1566", "T1204", "T1071"]),
    "Sliver": ("Multiple", ["T1071", "T1573", "T1105"]),
}
WORDS = ["cdn", "update", "secure", "login", "verify", "account", "cloud", "sync", "portal", "auth", "mail",
         "files", "drive", "api", "static", "edge", "panel", "office", "doc", "pay", "wallet", "support"]
TLDS = ["top", "xyz", "ru", "su", "click", "info", "biz", "online", "site", "live", "shop", "cc", "pw"]
FIRST_OCTETS = [5, 23, 31, 37, 45, 46, 62, 77, 79, 80, 85, 91, 92, 93, 94, 95, 103, 104, 141, 146, 151, 176,
                178, 185, 188, 193, 194, 195, 212, 213, 217]
CHANNELS = [("-100200300400", "DemoLeaks"), ("-100200300401", "DemoRansomWatch"), ("-100200300402", "DemoC2Feed")]
SOURCES = ["Demo Forum: Exploit Market", "Demo Paste Site", "Demo Ransom Leak Blog", "Demo Abuse Feed",
           "Demo Threat Report"]


@dataclass
class FixtureSummary:
    path: str
    rows: dict[str, int]


def _ts(d: datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


class _Gen:
    def __init__(self, seed: int) -> None:
        self.r = random.Random(seed)
        self.now = datetime.now(UTC)

    def ip(self) -> str:
        r = self.r
        return f"{r.choice(FIRST_OCTETS)}.{r.randint(0, 255)}.{r.randint(0, 255)}.{r.randint(1, 254)}"

    def domain(self) -> str:
        w = self.r.sample(WORDS, 2)
        suffix = "".join(self.r.choices(string.ascii_lowercase + string.digits, k=self.r.randint(0, 4)))
        return f"{w[0]}-{w[1]}{suffix}.{self.r.choice(TLDS)}"

    def onion(self) -> str:
        return "".join(self.r.choices("abcdefghijklmnopqrstuvwxyz234567", k=56)) + ".onion"

    def value(self) -> tuple[str, str]:
        roll = self.r.random()
        if roll < 0.30:
            return "ipv4", self.ip()
        if roll < 0.55:
            return "domain", self.domain()
        if roll < 0.70:
            path = self.r.choice(["/gate.php", "/panel/login", "/api/v1/beacon", "/dl/invoice.zip", "/"])
            return "url", f"{self.r.choice(['http', 'https'])}://{self.domain()}{path}"
        if roll < 0.76:
            return "cidr", f"{self.r.choice(FIRST_OCTETS)}.{self.r.randint(0, 255)}.{self.r.randint(0, 255)}.0/24"
        if roll < 0.82:
            return "ipv4_port", f"{self.ip()}:{self.r.choice([443, 8080, 4444, 8443, 50050, 2222])}"
        if roll < 0.88:
            return "onion", self.onion()
        if roll < 0.92:
            return "asn", f"AS{self.r.randint(1000, 60000)}"
        if roll < 0.94:
            return "ja3", "".join(self.r.choices("0123456789abcdef", k=32))
        if roll < 0.97:  # out of scope - must be skipped
            return self.r.choice([("md5", "".join(self.r.choices("0123456789abcdef", k=32))),
                                  ("email", f"ops{self.r.randint(1, 999)}@{self.domain()}"),
                                  ("cve", f"CVE-2026-{self.r.randint(1000, 99999)}")])
        if roll < 0.985:  # PII - must be dropped
            return "ssn_like", f"{self.r.randint(100, 899)}-{self.r.randint(10, 99)}-{self.r.randint(1000, 9999)}"
        return "ipv4", f"10.{self.r.randint(0, 255)}.{self.r.randint(0, 255)}.{self.r.randint(1, 254)}"  # private

    def defang(self, t: str, v: str) -> str:
        if self.r.random() < 0.25 and t in ("domain", "url", "ipv4"):
            return v.replace("http", "hxxp").replace(".", "[.]")
        return v

    def dates(self) -> tuple[datetime, datetime]:
        first = self.now - timedelta(days=self.r.uniform(0, 120), minutes=self.r.randint(0, 600))
        last = min(self.now, first + timedelta(days=self.r.uniform(0, 30)))
        return first, last

    def family(self) -> list[str]:
        return self.r.sample(list(FAMILIES), k=self.r.choice([0, 0, 1, 1, 2]))


def generate_fixture(
    dest: Path, count: int = 1500, seed: int = 1337, forbid_inside: Path | None = None
) -> FixtureSummary:
    dest = dest.resolve()
    if forbid_inside is not None:
        guard = forbid_inside.resolve()
        if dest == guard or guard in dest.parents:
            raise ValueError("refusing to write demo fixtures inside the real CTI data directory")
    if dest.exists():
        shutil.rmtree(dest)
    (dest / "darkweb_intel").mkdir(parents=True)
    (dest / "telegram-scraper" / "database").mkdir(parents=True)
    (dest / "DEMO_DATA_README.txt").write_text("Synthetic CyberAnchorage demo fixture. Not real threat intel.\n")

    g = _Gen(seed)
    shares = {"crawler": 0.35, "connector": 0.25, "ioc_hunter": 0.15, "telegram": 0.25}
    pool: list[tuple[str, str]] = []
    rows: dict[str, int] = {}

    def pick() -> tuple[str, str]:
        if pool and g.r.random() < 0.12:  # overlap between stores → exercises merge
            return g.r.choice(pool)
        tv = g.value()
        pool.append(tv)
        return tv

    for store in ("crawler", "connector"):
        con = sqlite3.connect(dest / "darkweb_intel" / f"{store}.db")
        con.executescript(CRAWLER_DDL)
        n = 0
        for _ in range(int(count * shares[store])):
            t, v = pick()
            first, last = g.dates()
            fams = g.family()
            sev = g.r.choice(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
            con.execute(
                "INSERT OR IGNORE INTO iocs (ioc_type, value, context, source_url, source_title, confidence, tlp,"
                " first_seen, last_seen, tags, origin, raw_json, score, severity, subtype, sightings)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("ip_address" if t == "ipv4" and g.r.random() < 0.5 else t, g.defang(t, v),
                 "[demo] synthetic context - never ingested", f"http://demo{g.r.randint(1, 9)}.example.invalid/post",
                 g.r.choice(SOURCES), g.r.choice(["LOW", "MEDIUM", "HIGH"]),
                 g.r.choice(["WHITE", "GREEN", "AMBER", "AMBER", "RED"]), _ts(first), _ts(last),
                 ",".join(g.r.sample(["c2", "phishing", "botnet", "ransomware", "scanner", "tor", "stealer"],
                                     k=g.r.randint(0, 2))),
                 "darkweb" if store == "crawler" else "connector",
                 json.dumps({"malware_family": fams, "note": "demo"}), g.r.randint(10, 100), sev,
                 g.r.choice(["GENERAL", "C2", "PHISHING", "PAYLOAD"]), g.r.randint(1, 12)))
            n += 1
        con.commit()
        con.close()
        rows[store] = n

    con = sqlite3.connect(dest / "darkweb_intel" / "ioc_hunter.db")
    con.executescript(HUNTER_DDL)
    n = 0
    for i in range(int(count * shares["ioc_hunter"])):
        t, v = pick()
        run_id = f"demo-run-{i % 7}"
        url = f"https://reports.example.invalid/{run_id}"
        first, _last = g.dates()
        con.execute("INSERT INTO iocs (run_id, ioc_type, value, normalized, confidence, category, tags, source_url,"
                    " source_title, source_domain, extracted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (run_id, t, g.defang(t, v), None, g.r.choice(["LOW", "MEDIUM", "HIGH"]),
                     g.r.choice(["c2", "phishing", "malware"]), "report", url, g.r.choice(SOURCES),
                     "reports.example.invalid", _ts(first)))
        n += 1
    for k in range(7):
        fam = list(FAMILIES)[k % len(FAMILIES)]
        actor, ttps = FAMILIES[fam]
        url = f"https://reports.example.invalid/demo-run-{k}"
        con.execute("INSERT INTO ttp_relations (run_id, group_name, ttp, source_url) VALUES (?,?,?,?)",
                    (f"demo-run-{k}", actor, ttps[0], url))
        con.execute("INSERT INTO malware_mentions (run_id, malware_name, apt_group, source_url, context)"
                    " VALUES (?,?,?,?,?)", (f"demo-run-{k}", fam, actor, url, "[demo] not ingested"))
    con.commit()
    con.close()
    rows["ioc_hunter"] = n

    con = sqlite3.connect(dest / "telegram-scraper" / "database" / "intel_iocs.db")
    con.executescript(TELEGRAM_DDL)
    for cid, name in CHANNELS:
        con.execute("INSERT INTO channels (channel_id, channel_name, first_seen, last_seen) VALUES (?,?,?,?)",
                    (cid, name, _ts(g.now - timedelta(days=120)), _ts(g.now)))
    n = 0
    for _ in range(int(count * shares["telegram"])):
        t, v = pick()
        first, last = g.dates()
        cid, cname = g.r.choice(CHANNELS)
        cur = con.execute(
            "INSERT OR IGNORE INTO iocs (ioc_type, ioc_value, defanged, confidence, first_seen, last_seen, sightings,"
            " channels, channel_count, severity, categories, malware_fams) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (t, v, v.replace(".", "[.]"), g.r.choice(["low", "medium", "high"]), _ts(first), _ts(last),
             g.r.randint(1, 5), cid, 1, g.r.choice(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
             ",".join(g.r.sample(["DATA_LEAK", "RANSOMWARE", "EXPLOIT", "MALWARE"], k=g.r.randint(1, 2))),
             ",".join(g.family())))
        if cur.lastrowid and cur.rowcount:
            con.execute("INSERT OR IGNORE INTO ioc_sightings (ioc_id, channel_id, channel_name, message_id, date,"
                        " confidence, context) VALUES (?,?,?,?,?,?,?)",
                        (cur.lastrowid, cid, cname, g.r.randint(1, 5000), _ts(last), "medium",
                         "[demo] message text - never ingested"))
            n += 1
    con.commit()
    con.close()
    rows["telegram"] = n

    con = sqlite3.connect(dest / "darkweb_intel" / "core.db")
    con.executescript(CORE_DDL)
    for fam, (actor, ttps) in FAMILIES.items():
        con.execute("INSERT OR IGNORE INTO apts (group_name, malware_families, ttps, confidence) VALUES (?,?,?,?)",
                    (actor, fam, ",".join(ttps), "medium"))
        if actor == "Multiple":
            con.execute("UPDATE apts SET malware_families = malware_families || ',' || ? WHERE group_name = ?",
                        (fam, actor))
    con.commit()
    con.close()
    return FixtureSummary(str(dest), rows)
