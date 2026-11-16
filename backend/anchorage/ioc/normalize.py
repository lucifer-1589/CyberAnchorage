"""IOC normalization: refang, canonicalize, validate.

Mirrors the CTI's conventions (lowercase, refang hxxp/[.], strip trailing dot, canonical IPv6,
URL normalization) and adds stricter validation. Adding a type = add a function + registry entry.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

import idna


class Rejected(ValueError):
    """Value is not a valid IOC of the claimed type (counted as `rejected`)."""


@dataclass(slots=True)
class Normalized:
    type: str
    value: str
    ip: str | None = None
    net: str | None = None
    port: int | None = None
    asn: int | None = None
    host: str | None = None
    extra_tags: list[str] = field(default_factory=list)

    @property
    def host_rev(self) -> str | None:
        return reverse_host(self.host) if self.host else None


def reverse_host(host: str) -> str:
    """`a.b.example.com` → `com.example.b.a.` (trailing dot makes suffix LIKE prefixes exact)."""
    return ".".join(reversed(host.split("."))) + "."


# ---------------------------------------------------------------- refang ---

_REFANG_SUBS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)\bhxxp(s?)(\[:\]|:)//"), r"http\1://"),
    (re.compile(r"(?i)\bhxxp(s?)\b"), r"http\1"),
    (re.compile(r"(?i)\bfxp(\[:\]|:)//"), "ftp://"),
    (re.compile(r"\[\.\]|\(\.\)|\{\.\}|\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}", re.I), "."),
    (re.compile(r"\[:\]"), ":"),
    (re.compile(r"\[/\]"), "/"),
    (re.compile(r"\[://\]"), "://"),
]


def refang(value: str) -> str:
    v = value.strip()
    for pat, repl in _REFANG_SUBS:
        v = pat.sub(repl, v)
    return v.strip().strip("'\"`<>").rstrip(",;")


def defang(value: str, ioc_type: str) -> str:
    """Display-safe form: hxxp://evil[.]com, 1[.]2[.]3[.]4."""
    if ioc_type in ("asn", "ja3", "ja3s"):
        return value
    v = re.sub(r"(?i)^http", "hxxp", value)
    v = re.sub(r"(?i)^ftp", "fxp", v)
    return v.replace(".", "[.]")


# ------------------------------------------------------------ IP helpers ---

def _reject_private(addr: ipaddress.IPv4Address | ipaddress.IPv6Address, allow_private: bool) -> None:
    if allow_private:
        return
    if (addr.is_private or addr.is_loopback or addr.is_multicast or addr.is_reserved
            or addr.is_link_local or addr.is_unspecified):
        raise Rejected("private/reserved address")


def _parse_ip(v: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    v = v.strip().strip("[]")
    if "%" in v:  # zone id
        raise Rejected("scoped IPv6 not supported")
    try:
        return ipaddress.ip_address(v)
    except ValueError as exc:
        raise Rejected("invalid IP") from exc


def norm_ip(value: str, allow_private: bool = False, want: int | None = None) -> Normalized:
    addr = _parse_ip(refang(value))
    declared_version = addr.version
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped  # ::ffff:a.b.c.d is canonically the IPv4 address
    if want and declared_version != want:
        raise Rejected(f"not an IPv{want} address")
    _reject_private(addr, allow_private)
    t = "ipv4" if addr.version == 4 else "ipv6"
    s = addr.compressed
    return Normalized(t, s, ip=s)


def norm_cidr(value: str, allow_private: bool = False) -> Normalized:
    v = refang(value)
    try:
        net = ipaddress.ip_network(v, strict=False)
    except ValueError as exc:
        raise Rejected("invalid CIDR") from exc
    if net.prefixlen == 0:
        raise Rejected("0-length prefix")
    if not allow_private and (net.is_private or net.is_loopback or net.is_multicast or net.is_reserved
                              or net.is_link_local):
        raise Rejected("private/reserved network")
    s = net.compressed
    return Normalized("cidr", s, net=s)


def norm_ip_port(value: str, allow_private: bool = False) -> Normalized:
    v = refang(value)
    m = re.fullmatch(r"\[([0-9a-fA-F:.]+)\]:(\d{1,5})", v) or re.fullmatch(r"([0-9.]+):(\d{1,5})", v)
    if not m:
        raise Rejected("invalid ip:port")
    port = int(m.group(2))
    if not 0 < port < 65536:
        raise Rejected("port out of range")
    ipn = norm_ip(m.group(1), allow_private)
    shown = f"[{ipn.value}]:{port}" if ipn.type == "ipv6" else f"{ipn.value}:{port}"
    return Normalized("ip:port", shown, ip=ipn.value, port=port)


# -------------------------------------------------------- domain helpers ---

_LABEL = re.compile(r"^(?!-)[a-z0-9_-]{1,63}(?<!-)$")
_ONION_V3 = re.compile(r"^[a-z2-7]{56}$")
_ONION_V2 = re.compile(r"^[a-z2-7]{16}$")
# Pseudo-TLDs that the CTI's regexes sometimes pick up from file names / code
_FAKE_TLDS = {"exe", "dll", "js", "php", "html", "htm", "png", "jpg", "jpeg", "gif", "txt", "zip", "rar",
              "pdf", "doc", "docx", "xls", "xlsx", "py", "sh", "bat", "ps1", "json", "xml", "log", "tmp",
              "local", "localhost", "internal", "lan", "invalid", "test", "example"}


def _norm_hostname(host: str) -> str:
    h = host.strip().lower().rstrip(".")
    if h.startswith("www.") and h.count(".") >= 2:
        pass  # keep www - it is a distinct host; CTI keeps it too
    if not h or len(h) > 253 or ".." in h:
        raise Rejected("invalid hostname")
    if any(ord(c) > 127 for c in h):
        try:
            h = idna.encode(h, uts46=True).decode("ascii")
        except idna.IDNAError as exc:
            raise Rejected("invalid IDN") from exc
    labels = h.split(".")
    if len(labels) < 2 or not all(_LABEL.match(lbl) for lbl in labels):
        raise Rejected("invalid hostname")
    tld = labels[-1]
    if tld.isdigit() or tld in _FAKE_TLDS:
        raise Rejected("invalid TLD")
    return h


def norm_onion(value: str) -> Normalized:
    v = refang(value).lower()
    if "://" in v:
        v = urlsplit(v).hostname or ""
    h = v.rstrip(".").split(":")[0]
    if not h.endswith(".onion"):
        raise Rejected("not an onion address")
    service = h.split(".")[-2]
    if not (_ONION_V3.match(service) or _ONION_V2.match(service)):
        raise Rejected("invalid onion service id")
    return Normalized("onion", h, host=h)


def norm_domain(value: str, allow_private: bool = False) -> Normalized:
    v = refang(value)
    if "://" in v or "/" in v:
        raise Rejected("domain contains URL parts")
    if v.lower().rstrip(".").endswith(".onion"):
        return norm_onion(v)
    try:  # an IP is not a domain
        ipaddress.ip_address(v.strip("[]"))
        raise Rejected("IP literal given as domain")
    except ValueError:
        pass
    h = _norm_hostname(v)
    return Normalized("domain", h, host=h)


_DEFAULT_PORTS = {"http": 80, "https": 443, "ftp": 21}


def norm_url(value: str, allow_private: bool = False) -> Normalized:
    v = refang(value)
    if "://" not in v:
        raise Rejected("URL without scheme")
    try:
        parts = urlsplit(v)
        port = parts.port
    except ValueError as exc:
        raise Rejected("unparseable URL") from exc
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https", "ftp", "ws", "wss"):
        raise Rejected("unsupported scheme")
    raw_host = parts.hostname or ""
    tags: list[str] = []
    ip_val: str | None = None
    try:
        addr = ipaddress.ip_address(raw_host.strip("[]"))
        _reject_private(addr, allow_private)
        host = addr.compressed
        ip_val = host
        netloc_host = f"[{host}]" if addr.version == 6 else host
    except ValueError:
        if raw_host.endswith(".onion"):
            host = norm_onion(raw_host).value
            tags.append("onion")
        else:
            host = _norm_hostname(raw_host)
        netloc_host = host
    if port and _DEFAULT_PORTS.get(scheme) != port:
        netloc_host = f"{netloc_host}:{port}"
    path = parts.path or "/"
    # collapse ellipsis-truncated values (CTI sometimes stores `...` cut URLs)
    if "..." in path:
        tags.append("truncated")
    norm = urlunsplit((scheme, netloc_host, path, parts.query, ""))
    if len(norm) > 2048:
        raise Rejected("URL too long")
    if host.endswith(".onion") and path == "/" and not parts.query:
        return Normalized("onion", host, host=host)
    return Normalized("url", norm, ip=ip_val, host=None if ip_val else host, port=port, extra_tags=tags)


def norm_asn(value: str, allow_private: bool = False) -> Normalized:
    v = refang(value).upper().replace(" ", "")
    m = re.fullmatch(r"(?:AS)?(\d{1,10})", v)
    if not m:
        raise Rejected("invalid ASN")
    n = int(m.group(1))
    if n == 0 or n > 4294967295 or 64512 <= n <= 65534 or 4200000000 <= n <= 4294967294 or n in (23456, 65535):
        raise Rejected("reserved/private ASN")
    return Normalized("asn", f"AS{n}", asn=n)


def _norm_md5ish(t: str) -> Callable[[str, bool], Normalized]:
    def _f(value: str, allow_private: bool = False) -> Normalized:
        v = value.strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", v):
            raise Rejected(f"invalid {t} fingerprint")
        return Normalized(t, v)

    return _f


# ---------------------------------------------------------------- registry ---

Normalizer = Callable[[str, bool], Normalized]

def _norm_ipv4(v: str, p: bool = False) -> Normalized:
    return norm_ip(v, p, want=4)


def _norm_ipv6(v: str, p: bool = False) -> Normalized:
    return norm_ip(v, p, want=6)


def _norm_onion_t(v: str, p: bool = False) -> Normalized:
    return norm_onion(v)


TYPE_REGISTRY: dict[str, Normalizer] = {
    "ipv4": _norm_ipv4,
    "ipv6": _norm_ipv6,
    "ip": norm_ip,  # generic, resolves to ipv4/ipv6
    "cidr": norm_cidr,
    "domain": norm_domain,
    "url": norm_url,
    "ip:port": norm_ip_port,
    "onion": _norm_onion_t,
    "asn": norm_asn,
    "ja3": _norm_md5ish("ja3"),
    "ja3s": _norm_md5ish("ja3s"),
}

# Canonical types shown in the product (registry keys minus the generic `ip` resolver)
CANONICAL_TYPES = ("ipv4", "ipv6", "cidr", "domain", "url", "ip:port", "onion", "asn", "ja3", "ja3s")

# CTI vocabulary → registry key (see PLAN.md §1)
SOURCE_TYPE_ALIASES: dict[str, str] = {
    "ipv4": "ipv4", "ip_v4": "ip", "ipv6": "ipv6", "ip_v6": "ip", "ip_address": "ip", "ip": "ip",
    "cidr": "cidr", "netblock": "cidr",
    "domain": "domain", "hostname": "domain", "fqdn": "domain",
    "url": "url", "url_pattern": "url", "uri": "url",
    "dark_url": "url", "onion": "onion", "onion_v2": "onion", "onion_v3": "onion",
    "ipv4_port": "ip:port", "ip_port": "ip:port", "ip:port": "ip:port", "socket": "ip:port",
    "asn": "asn", "as": "asn",
    "ja3": "ja3", "ja3s": "ja3s", "ja3_hash": "ja3", "ja3s_hash": "ja3s",
}

# Always dropped, regardless of settings.
PII_TYPES = frozenset({
    "ssn_like", "card_like", "iban_like", "ssn_pattern", "cc_pattern", "iban_pattern", "credential",
    "credential_pair", "username", "password", "phone", "ssn", "credit_card", "iban",
})


class Skip(Exception):
    """Out-of-scope type (counted as `skipped`, not an error)."""


def normalize(source_type: str, value: str, *, allow_private: bool = False,
              enabled_types: frozenset[str] | None = None) -> Normalized:
    """Normalize a CTI record. Raises Skip (out of scope / PII) or Rejected (invalid)."""
    st = (source_type or "").strip().lower()
    if st in PII_TYPES:
        raise Skip("pii")
    key = SOURCE_TYPE_ALIASES.get(st)
    if key is None:
        raise Skip("out_of_scope")
    if value is None or not str(value).strip():
        raise Rejected("empty value")
    if len(str(value)) > 4096:
        raise Rejected("value too long")
    out = TYPE_REGISTRY[key](str(value), allow_private)
    if enabled_types is not None and out.type not in enabled_types:
        raise Skip("type_disabled")
    return out


def guess(value: str, allow_private: bool = True) -> Normalized | None:
    """Best-effort type detection for real-time observables and free-text search."""
    v = refang(value)
    if not v:
        return None
    order = ["ip", "ip:port", "url", "domain"]
    if "/" in v and "://" not in v:
        order.insert(0, "cidr")
    if re.fullmatch(r"(?i)AS\d+", v):
        order.insert(0, "asn")
    for t in order:
        try:
            return TYPE_REGISTRY[t](v, allow_private)
        except Rejected:
            continue
    return None
