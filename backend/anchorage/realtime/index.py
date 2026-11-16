"""In-memory matcher index for real-time events.

* exact hash sets per (type, value) for ip / domain / url / onion / ip:port / asn / ja3
* binary radix trie (per address family) for CIDR IOCs → longest-to-shortest prefix hits
* reversed-label trie for domain suffix matches (an event for a.b.evil.com hits IOC evil.com)
* compiled rule predicates (the same AST/compiler as the retro pass) + allowlist predicate
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from anchorage.rules.compile import Predicate


@dataclass(slots=True)
class IocEntry:
    id: int
    type: str
    value: str
    verdict: str | None
    severity: str | None
    severity_rank: int
    view: dict[str, Any]


@dataclass(slots=True)
class RuleEntry:
    id: int
    name: str
    version: int
    verdict: str
    severity: str
    severity_rank: int
    priority: int
    predicate: Predicate


class _BitNode:
    __slots__ = ("children", "items")

    def __init__(self) -> None:
        self.children: list[_BitNode | None] = [None, None]
        self.items: list[IocEntry] = []


class CidrTrie:
    """Binary trie keyed by network bits; lookup walks the address and collects every covering prefix."""

    def __init__(self) -> None:
        self._roots = {4: _BitNode(), 6: _BitNode()}
        self.size = 0

    def insert(self, cidr: str, entry: IocEntry) -> None:
        net = ipaddress.ip_network(cidr, strict=False)
        bits = int(net.network_address)
        width = net.max_prefixlen
        node = self._roots[net.version]
        for i in range(net.prefixlen):
            b = (bits >> (width - 1 - i)) & 1
            nxt = node.children[b]
            if nxt is None:
                nxt = node.children[b] = _BitNode()
            node = nxt
        node.items.append(entry)
        self.size += 1

    def lookup(self, ip: str) -> list[IocEntry]:
        addr = ipaddress.ip_address(ip)
        bits, width = int(addr), addr.max_prefixlen
        node: _BitNode | None = self._roots[addr.version]
        hits: list[IocEntry] = []
        i = 0
        while node is not None:
            hits.extend(node.items)
            if i == width:
                break
            node = node.children[(bits >> (width - 1 - i)) & 1]
            i += 1
        return hits[::-1]  # most specific first


class _LabelNode:
    __slots__ = ("children", "items")

    def __init__(self) -> None:
        self.children: dict[str, _LabelNode] = {}
        self.items: list[IocEntry] = []


class LabelTrie:
    """Reversed-label trie: com → evil → www. Lookup returns entries for the host and every parent domain."""

    def __init__(self) -> None:
        self._root = _LabelNode()
        self.size = 0

    def insert(self, domain: str, entry: IocEntry) -> None:
        node = self._root
        for label in reversed(domain.lower().strip(".").split(".")):
            node = node.children.setdefault(label, _LabelNode())
        node.items.append(entry)
        self.size += 1

    def lookup(self, host: str) -> list[IocEntry]:
        node = self._root
        hits: list[IocEntry] = []
        for label in reversed(host.lower().strip(".").split(".")):
            nxt = node.children.get(label)
            if nxt is None:
                break
            node = nxt
            hits.extend(node.items)
        return hits[::-1]  # most specific first


@dataclass
class MatcherIndex:
    exact: dict[tuple[str, str], IocEntry] = field(default_factory=dict)
    cidr: CidrTrie = field(default_factory=CidrTrie)
    suffix: LabelTrie = field(default_factory=LabelTrie)
    rules: list[RuleEntry] = field(default_factory=list)
    allow: Predicate = field(default=lambda v: False)
    built_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    build_ms: float = 0.0

    def add_ioc(self, e: IocEntry) -> None:
        if e.type == "cidr":
            self.cidr.insert(e.value, e)
        else:
            self.exact[(e.type, e.value)] = e
        if e.type in ("domain", "onion"):
            self.suffix.insert(e.value, e)

    def lookup(self, obs_type: str, value: str, ip: str | None, host: str | None) -> list[tuple[IocEntry, str]]:
        out: list[tuple[IocEntry, str]] = []
        seen: set[int] = set()

        def add(entries: list[IocEntry], how: str) -> None:
            for e in entries:
                if e.id not in seen:
                    seen.add(e.id)
                    out.append((e, how))

        hit = self.exact.get((obs_type, value))
        add([hit] if hit else [], "exact")
        if ip:
            ip_type = "ipv6" if ":" in ip else "ipv4"
            if obs_type != ip_type:  # ip:port or URL with IP host also matches the bare IP IOC
                e = self.exact.get((ip_type, ip))
                add([e] if e else [], "exact")
            add(self.cidr.lookup(ip), "cidr")
        if host:
            if obs_type == "url":
                e = self.exact.get(("domain", host))
                add([e] if e else [], "exact")
            add([e for e in self.suffix.lookup(host) if e.value != host or obs_type != e.type], "domain_suffix")
        return out

    def stats(self) -> dict[str, Any]:
        return {"exact": len(self.exact), "cidr": self.cidr.size, "suffix": self.suffix.size,
                "rules": len(self.rules), "built_at": self.built_at.isoformat(), "build_ms": round(self.build_ms, 1)}
