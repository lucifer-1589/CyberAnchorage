"""Shared enumerations and rank helpers."""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    admin = "admin"
    analyst = "analyst"
    viewer = "viewer"


ROLE_RANK = {Role.viewer: 1, Role.analyst: 2, Role.admin: 3}


class Verdict(StrEnum):
    abnormal = "abnormal"
    suspicious = "suspicious"
    malicious = "malicious"


VERDICT_RANK = {Verdict.abnormal: 1, Verdict.suspicious: 2, Verdict.malicious: 3}


class Severity(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


SEVERITY_RANK = {Severity.low: 1, Severity.medium: 2, Severity.high: 3, Severity.critical: 4}


class IocStatus(StrEnum):
    active = "active"
    expired = "expired"
    retired = "retired"


# TLP 2.0, strictest wins
TLP_RANK = {"CLEAR": 0, "GREEN": 1, "AMBER": 2, "AMBER+STRICT": 3, "RED": 4}
TLP_ALIASES = {"WHITE": "CLEAR", "AMBER_STRICT": "AMBER+STRICT", "AMBERSTRICT": "AMBER+STRICT"}


def norm_tlp(value: str | None, default: str = "AMBER") -> str:
    if not value:
        return default
    v = value.strip().upper().removeprefix("TLP:").replace(" ", "")
    v = TLP_ALIASES.get(v, v)
    return v if v in TLP_RANK else default


class SyncKind(StrEnum):
    hourly = "hourly"
    daily = "daily"
    manual = "manual"


class SyncStatus(StrEnum):
    queued = "queued"
    running = "running"
    success = "success"
    partial = "partial"
    failed = "failed"
    skipped = "skipped"


class AllowKind(StrEnum):
    value = "value"
    cidr = "cidr"
    domain_suffix = "domain_suffix"
