import { useUi } from "@/store/ui";
import type { EffectsPref } from "@/lib/perf";
import { Segmented } from "@/components/ui/primitives";

const OPTIONS: { value: EffectsPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full" },
  { value: "reduced", label: "Reduced" },
  { value: "off", label: "Off" },
];

/** Settings › Visual effects. Off removes every backdrop-filter and non-essential animation; layout never changes. */
export function EffectsToggle({ showMeta = true }: { showMeta?: boolean }) {
  const pref = useUi((s) => s.effectsPref);
  const effects = useUi((s) => s.effects);
  const tier = useUi((s) => s.tier);
  const measured = useUi((s) => s.tierMeasured);
  const set = useUi((s) => s.setEffectsPref);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <Segmented label="Visual effects" value={pref} onChange={set} options={OPTIONS} />
      {showMeta && pref === "auto" && (
        <span className="text-xs text-fg-subtle" aria-live="polite">
          Auto → {effects} ({tier} tier{measured ? "" : ", measuring"})
        </span>
      )}
    </span>
  );
}
