export type Role = "admin" | "analyst" | "viewer";
export type Verdict = "abnormal" | "suspicious" | "malicious";
export type Severity = "low" | "medium" | "high" | "critical";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  last_login_at?: string | null;
}

export interface Ioc {
  id: number;
  type: string;
  value: string; // always defanged
  sources: string[];
  source_count: number;
  first_seen: string | null;
  last_seen: string | null;
  tlp: string;
  score: number;
  confidence: number;
  tags: string[];
  malware_families: string[];
  actors: string[];
  mitre_ids: string[];
  status: string;
  expires_at: string | null;
  allowlisted: boolean;
  verdict: Verdict | null;
  severity: Severity | null;
  port?: number | null;
  asn?: number | null;
  is_demo: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  total_is_estimate?: boolean;
}

export interface SourceRef {
  k: string;
  source: string;
  title?: string | null;
  url?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
  channels: string[];
  sightings?: number | null;
  severity?: string | null;
  messages: { channel?: string; message_id?: number; date?: string }[];
}

export interface IocDetail {
  ioc: Ioc;
  source_refs: SourceRef[];
  flags: {
    rule_id: number;
    rule_name: string;
    rule_version: number;
    current_rule_version: number;
    verdict: Verdict;
    severity: Severity;
    ts: string;
  }[];
  detections: number;
}

export type Condition =
  | { id?: string; op: "and" | "or"; children: Condition[] }
  | { id?: string; op: "not"; child: Condition }
  | { id?: string; field: string; operator: string; value: unknown };

export interface Rule {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  verdict: Verdict;
  severity: Severity;
  condition: Condition;
  expires_at: string | null;
  version: number;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string | null;
  match_count: number;
}

export interface FieldSpec {
  name: string;
  label: string;
  kind: "enum" | "value" | "array" | "number" | "age" | "tlp" | "int_set";
  operators: string[];
  help: string;
  options: string[];
  min: number | null;
  max: number | null;
}

export interface SyncRun {
  id: number;
  kind: string;
  mode: string;
  status: "queued" | "running" | "success" | "partial" | "failed" | "skipped";
  triggered_by: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  new: number;
  updated: number;
  unchanged: number;
  expired: number;
  rejected: number;
  skipped: number;
  flagged: number;
  errors: Record<string, string>[];
  stats: Record<string, any>;
}

export interface Detection {
  id: number;
  ts: string;
  event_ts: string | null;
  source: string;
  observable: string;
  observable_type: string;
  matched_by: string;
  ioc_id: number | null;
  rule_ids: number[];
  verdict: Verdict;
  severity: Severity;
  is_simulated: boolean;
  event: Record<string, any>;
}

export interface AllowEntry {
  id: number;
  kind: "value" | "cidr" | "domain_suffix";
  ioc_type: string | null;
  value: string;
  reason: string;
  expires_at: string | null;
  created_by_email: string | null;
  created_at: string;
}

export interface Facet {
  key: string;
  count: number;
}
