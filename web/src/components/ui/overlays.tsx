import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DUR, EASE, settle } from "@/lib/motion";
import { motionOK } from "@/lib/perf";

/* ------------------------------------------------------------------ Sheet ---
 * All overlays are drawers: right-side panel on desktop/tablet, bottom sheet on phones. */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

/** Shared-element open: the G2 panel starts at `origin` (e.g. the clicked table row) and grows to its
 *  own rect with transform only; its contents fade in from 35 %. Glass settles while it moves. */
function useFlipFrom(origin: DOMRect | null | undefined) {
  return React.useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      requestAnimationFrame(() => {
        if (origin && origin.width && motionOK() && el.animate && matchMedia("(min-width: 640px)").matches) {
          el.getAnimations().forEach((a) => a.cancel()); // replace the CSS slide with the FLIP
          const f = el.getBoundingClientRect();
          const dx = origin.left - f.left;
          const dy = origin.top - f.top;
          el.animate(
            [
              { transform: `translate(${dx}px, ${dy}px) scale(${origin.width / f.width}, ${origin.height / f.height})`, opacity: 0.55 },
              { transform: "none", opacity: 1 },
            ],
            { duration: DUR[3], easing: EASE.emphasized },
          );
          Array.from(el.children).forEach((c) => c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: DUR[3] }));
        }
        settle(el);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

export function SheetContent({
  title,
  description,
  children,
  className,
  wide,
  side = "right",
  origin,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
  side?: "right" | "left";
  /** rect of the element that opened the sheet (shared-element transition) */
  origin?: DOMRect | null;
}) {
  const flipRef = useFlipFrom(origin);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(var(--scrim)/var(--scrim-a))] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <DialogPrimitive.Content
        ref={flipRef}
        className={cn(
          "glass-strong fixed z-50 flex flex-col outline-none duration-3 ease-emphasized data-[state=closed]:duration-2 data-[state=closed]:ease-exit",
          // phones: bottom sheet
          "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom",
          // >= sm: side drawer
          "sm:inset-y-2 sm:bottom-auto sm:h-[calc(100%-1rem)] sm:max-h-none sm:rounded-3xl",
          side === "right"
            ? "sm:left-auto sm:right-2 sm:data-[state=open]:slide-in-from-right-8 sm:data-[state=open]:fade-in-0 sm:data-[state=closed]:slide-out-to-right-6 sm:data-[state=closed]:fade-out-0"
            : "sm:left-0 sm:right-auto sm:border-y-0 sm:border-l-0 sm:data-[state=open]:slide-in-from-left sm:data-[state=closed]:slide-out-to-left",
          wide ? "sm:w-[min(760px,calc(100vw-1rem))]" : "sm:w-[min(520px,calc(100vw-1rem))]",
          className,
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-[rgb(var(--hover)/0.25)] sm:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="truncate text-[17px] font-semibold leading-6 text-fg">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-0.5 text-[13px] text-fg-muted">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">Details panel</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="rounded-lg p-1.5 text-fg-muted hover:bg-[rgb(var(--hover)/var(--hover-a))] hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/* --------------------------------------------------------------- Dropdown --- */

export const Dropdown = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export function DropdownContent({ className, ...props }: DropdownPrimitive.DropdownMenuContentProps) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={6}
        className={cn("glass-strong z-50 min-w-[190px] rounded-xl p-1 duration-2 ease-emphasized data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0", className)}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownItem({ className, ...props }: DropdownPrimitive.DropdownMenuItemProps) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-primary/15 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownCheckbox({ className, children, ...props }: DropdownPrimitive.DropdownMenuCheckboxItemProps) {
  return (
    <DropdownPrimitive.CheckboxItem
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-[rgb(var(--hover)/0.08)]",
        className,
      )}
      onSelect={(e) => e.preventDefault()}
      {...props}
    >
      <span
        className={cn(
          "grid size-4 place-items-center rounded border border-line text-[10px]",
          props.checked && "border-primary bg-primary text-primary-fg",
        )}
        aria-hidden
      >
        {props.checked ? "✓" : ""}
      </span>
      {children}
    </DropdownPrimitive.CheckboxItem>
  );
}

export const DropdownSeparator = () => <DropdownPrimitive.Separator className="my-1 h-px bg-[rgb(var(--line)/var(--line-a))]" />;
export const DropdownLabel = ({ children }: { children: React.ReactNode }) => (
  <DropdownPrimitive.Label className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{children}</DropdownPrimitive.Label>
);

/* ---------------------------------------------------------------- Tooltip --- */

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-toast max-w-xs rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium text-bg shadow-lg duration-1 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-[.98]"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ----------------------------------------------------------------- Switch --- */

export function Switch({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line bg-[rgb(var(--hover)/0.14)] transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[17px]" />
    </SwitchPrimitive.Root>
  );
}

/* ------------------------------------------------------------------- Tabs --- */

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return <TabsPrimitive.List className={cn("flex gap-1 border-b border-line px-4", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px border-b-2 border-transparent px-2.5 py-2 text-[13px] font-medium text-fg-muted transition-colors duration-1 hover:text-fg data-[state=active]:border-[rgb(var(--grad-2))] data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}
