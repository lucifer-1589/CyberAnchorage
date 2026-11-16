import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/overlays";
import { SeverityBadge, VerdictBadge } from "@/components/badges";
import { ConditionEditor, stripIds, withIds } from "@/components/RuleBuilder";
import { IocValue } from "@/components/IocValue";
import { qs } from "@/lib/api";
import { useAuth } from "@/store/auth";
import type { Condition, FieldSpec } from "@/lib/types";

const wrap = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe("badges", () => {
  it("severity carries a text label and accessible name, not just colour", () => {
    wrap(<SeverityBadge severity="critical" />);
    expect(screen.getByLabelText("Severity critical")).toHaveTextContent("critical");
  });
  it("verdict shows label; allowlisted overrides", () => {
    const { rerender } = wrap(<VerdictBadge verdict="malicious" />);
    expect(screen.getByText("malicious")).toBeInTheDocument();
    rerender(<TooltipProvider><VerdictBadge verdict="malicious" allowlisted /></TooltipProvider>);
    expect(screen.getByText("allowlisted")).toBeInTheDocument();
  });
});

const FIELDS: FieldSpec[] = [
  { name: "type", label: "IOC type", kind: "enum", operators: ["eq", "in"], help: "", options: ["ipv4", "domain"], min: null, max: null },
  { name: "score", label: "Score", kind: "number", operators: ["gte", "between"], help: "", options: [], min: 0, max: 1 },
];

describe("rule builder", () => {
  it("round-trips ids without leaking them into the payload", () => {
    const c: Condition = { op: "and", children: [{ field: "type", operator: "in", value: ["ipv4"] }, { op: "not", child: { field: "score", operator: "gte", value: 0.5 } }] };
    const withI = withIds(c);
    expect(JSON.stringify(withI)).toContain('"id"');
    expect(stripIds(withI)).toEqual(c);
  });

  it("adds a condition and toggles AND/OR", () => {
    let latest: Condition | null = null;
    function Host() {
      const [c, setC] = useState<Condition>(withIds({ op: "and", children: [{ field: "type", operator: "in", value: ["ipv4"] }] }));
      latest = c;
      return <ConditionEditor node={c} fields={FIELDS} onChange={setC} />;
    }
    wrap(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Condition" }));
    fireEvent.click(screen.getByRole("radio", { name: "or" }));
    const out = stripIds(latest!) as any;
    expect(out.op).toBe("or");
    expect(out.children).toHaveLength(2);
  });
});

describe("IOC values", () => {
  it("renders the defanged value and hides reveal from viewers", () => {
    useAuth.setState({ user: { id: 1, email: "v@x.io", name: "", role: "viewer", is_active: true }, token: "t", ready: true });
    wrap(<IocValue id={1} value="hxxps://evil[.]com/x" />);
    expect(screen.getByText("hxxps://evil[.]com/x")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reveal live value")).toBeNull();
  });
  it("offers reveal to analysts", () => {
    useAuth.setState({ user: { id: 2, email: "a@x.io", name: "", role: "analyst", is_active: true }, token: "t", ready: true });
    wrap(<IocValue id={1} value="evil[.]com" />);
    expect(screen.getByLabelText("Reveal live value")).toBeInTheDocument();
  });
});

describe("api helpers", () => {
  it("builds repeated query params and skips empties", () => {
    expect(qs({ type: ["ipv4", "domain"], q: "", limit: 5, x: undefined })).toBe("?type=ipv4&type=domain&limit=5");
  });
});
