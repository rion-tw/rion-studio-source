import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes, type MutableRefObject, type ReactNode, forwardRef, useCallback, useLayoutEffect, useRef } from "react";
import { type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";

const surfaceVariants = cva("text-card-foreground", {
  variants: {
    variant: {
      panel: "glass-panel",
      strong: "glass-panel-strong",
      modal: "glass-modal",
      inset: "glass-inset",
      popover: "glass-popover",
      control: "glass-control"
    },
    padding: {
      none: "",
      xs: "p-1",
      sm: "p-2",
      md: "p-3",
      lg: "p-4"
    },
    radius: {
      sm: "rounded-xs",
      md: "rounded-md",
      lg: "rounded-lg"
    }
  },
  defaultVariants: {
    variant: "panel",
    padding: "none",
    radius: "md"
  }
});

interface SurfaceProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceVariants> {}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, padding, radius, variant, ...props }, ref) => (
    <div ref={ref} className={cn(surfaceVariants({ className, padding, radius, variant }))} {...props} />
  )
);

Surface.displayName = "Surface";

type HelpPanelProps = HTMLAttributes<HTMLDivElement>;

export const HelpPanel = forwardRef<HTMLDivElement, HelpPanelProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-md border border-border/45 p-4", className)} {...props} />
  )
);

HelpPanel.displayName = "HelpPanel";

interface PageFrameProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  containerRef?: MutableRefObject<HTMLElement | null>;
  contentClassName?: string;
  maxWidth?: "wide" | "settings";
  scrollPositionRef?: MutableRefObject<number>;
}

export function PageFrame({
  children,
  className,
  containerRef,
  contentClassName,
  maxWidth = "wide",
  onScroll,
  scrollPositionRef,
  ...props
}: PageFrameProps) {
  const maxWidthClassName = maxWidth === "settings" ? "max-w-5xl" : "max-w-[1500px]";
  const frameRef = useRef<HTMLElement>(null);
  const setFrameRef = useCallback((element: HTMLElement | null): void => {
    frameRef.current = element;
    if (containerRef) {
      containerRef.current = element;
    }
  }, [containerRef]);

  useLayoutEffect(() => {
    if (frameRef.current && scrollPositionRef) {
      frameRef.current.scrollTop = scrollPositionRef.current;
    }
  }, [scrollPositionRef]);

  return (
    <section
      ref={setFrameRef}
      className={cn("app-page relative h-full overflow-auto px-6 py-7", className)}
      onScroll={(event) => {
        if (scrollPositionRef) {
          scrollPositionRef.current = event.currentTarget.scrollTop;
        }
        onScroll?.(event);
      }}
      {...props}
    >
      <div
        className={cn(
          "mx-auto min-h-full w-full",
          maxWidthClassName,
          contentClassName ?? "flex flex-col gap-4"
        )}
      >
        {children}
      </div>
    </section>
  );
}

interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  description?: ReactNode;
  kicker?: ReactNode;
  title: ReactNode;
}

export function PageHeader({ actions, className, description, kicker, title, ...props }: PageHeaderProps) {
  return (
    <header className={cn("app-page-header flex flex-col gap-3", className)} {...props}>
      <div className="min-w-0 max-w-2xl">
        {kicker ? <p className="app-page-kicker">{kicker}</p> : null}
        <h1 className="app-page-title">{title}</h1>
        {description ? <p className="app-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="app-page-actions flex w-full flex-col gap-1.5">{actions}</div> : null}
    </header>
  );
}

const iconTileVariants = cva("glass-control flex shrink-0 items-center justify-center text-muted-foreground", {
  variants: {
    size: {
      sm: "h-7 w-7 rounded-md",
      md: "size-[var(--control-height)] rounded-md",
      lg: "h-12 w-12 rounded-lg"
    }
  },
  defaultVariants: {
    size: "md"
  }
});

interface IconTileProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof iconTileVariants> {}

export const IconTile = forwardRef<HTMLDivElement, IconTileProps>(
  ({ className, size, ...props }, ref) => (
    <div ref={ref} className={cn(iconTileVariants({ className, size }))} {...props} />
  )
);

IconTile.displayName = "IconTile";

interface FieldHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  description?: ReactNode;
  title: ReactNode;
}

export function FieldHeader({ className, description, title, ...props }: FieldHeaderProps) {
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <p className="text-body font-semibold text-foreground">{title}</p>
      {description ? <p className="mt-0.5 text-control text-muted-foreground">{description}</p> : null}
    </div>
  );
}

interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  children?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}

export function Field({ children, className, description, title, ...props }: FieldProps) {
  return (
    <div className={cn("flex h-full min-w-0 flex-col justify-between gap-2", className)} {...props}>
      <FieldHeader description={description} title={title} />
      {children}
    </div>
  );
}

interface FormFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  children: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  label: ReactNode;
}

export function FormField({
  children,
  className,
  description,
  htmlFor,
  label,
  ...props
}: FormFieldProps) {
  const labelClassName = "block text-body font-semibold text-foreground";

  return (
    <div className={cn("flex h-full min-w-0 flex-col justify-between gap-2", className)} {...props}>
      <div className="min-w-0">
        {htmlFor ? (
          <label className={labelClassName} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <p className={labelClassName}>{label}</p>
        )}
        {description ? (
          <p className="mt-0.5 text-control text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

interface FormGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: 1 | 2 | 3;
}

export function FormGrid({ children, className, columns = 1, ...props }: FormGridProps) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-x-3 gap-y-3.5",
        columns === 2 && "form-grid-2",
        columns === 3 && "form-grid-3",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface CountPillProps {
  children: ReactNode;
  className?: string;
}

function CountPill({ children, className }: CountPillProps) {
  return (
    <span
      className={cn(
        "count-pill inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/30 bg-background/35 px-1 text-micro leading-none text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  );
}

interface SegmentedItem<T extends string> {
  count?: number;
  icon?: LucideIcon;
  label: string;
  value: T;
}

interface SegmentedControlProps<T extends string> extends HTMLAttributes<HTMLDivElement> {
  disabled?: boolean;
  items: Array<SegmentedItem<T>>;
  onValueChange: (value: T) => void;
  value: T;
}

export function SegmentedControl<T extends string>({
  className,
  disabled = false,
  items,
  onValueChange,
  value,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <Surface className={cn("grid gap-1 rounded-md p-[var(--segmented-inset)]", className)} padding="none" variant="inset" {...props}>
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.value === value;

        return (
          <button
            key={item.value}
            aria-pressed={isActive}
            disabled={disabled}
            className={cn(
              "flex h-[var(--control-height)] min-h-[var(--control-min-size)] min-w-[var(--control-min-size)] items-center justify-center gap-1.5 rounded-sm border border-transparent px-3 text-control font-semibold leading-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45",
              isActive
                ? "glass-control-selected border-[hsl(var(--glass-border))] text-foreground"
                : "text-muted-foreground hover:bg-accent/35 hover:text-foreground"
            )}
            type="button"
            onClick={() => onValueChange(item.value)}
          >
            {Icon ? <Icon size={14} /> : null}
            <span className="min-w-0 truncate">{item.label}</span>
            {typeof item.count === "number" ? <CountPill>{item.count}</CountPill> : null}
          </button>
        );
      })}
    </Surface>
  );
}

interface NavItemProps {
  active?: boolean;
  className?: string;
  count?: number;
  href?: string;
  icon: LucideIcon;
  label: string;
  noDrag?: boolean;
  onClick?: () => void;
  statusDotLabel?: string;
  showStatusDot?: boolean;
}

export function NavItem({
  active = false,
  className,
  count,
  href,
  icon: Icon,
  label,
  noDrag = false,
  onClick,
  statusDotLabel,
  showStatusDot = false
}: NavItemProps) {
  const content = (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-current">
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof count === "number" ? <CountPill className="h-5 min-w-5 px-1.5 text-micro">{count}</CountPill> : null}
      {showStatusDot ? (
        <span
          aria-label={statusDotLabel}
          className="size-2 shrink-0 rounded-full bg-activity ring-2 ring-activity/15"
          role={statusDotLabel ? "status" : undefined}
        />
      ) : null}
    </>
  );
  const itemClassName = cn(
    noDrag && "app-no-drag",
    "nav-item flex h-8 items-center gap-2 rounded-sm border border-transparent px-2.5 text-left text-control font-medium leading-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25",
    active
      ? "nav-item-active border-[hsl(var(--glass-border))] text-foreground"
      : "text-muted-foreground hover:bg-accent/35 hover:text-foreground",
    className
  );

  if (href) {
    return (
      <a className={itemClassName} href={href}>
        {content}
      </a>
    );
  }

  return (
    <button className={itemClassName} type="button" onClick={onClick}>
      {content}
    </button>
  );
}

const calloutVariants = cva(
  "flex items-start gap-2 rounded-sm border px-3 py-2 text-control",
  {
    variants: {
      tone: {
        activity: "border-activity/30 bg-activity/8 text-activity",
        destructive: "border-destructive/30 bg-destructive/8 text-destructive",
        muted: "border-border/45 bg-background/25 text-muted-foreground",
        success: "border-success-foreground/20 bg-success/65 text-success-foreground",
        warning: "border-warning-foreground/25 bg-warning/55 text-warning-foreground"
      }
    },
    defaultVariants: {
      tone: "muted"
    }
  }
);

interface StatusCalloutProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof calloutVariants> {}

export const StatusCallout = forwardRef<HTMLDivElement, StatusCalloutProps>(
  ({ className, tone, ...props }, ref) => (
    <div ref={ref} className={cn(calloutVariants({ className, tone }))} {...props} />
  )
);

StatusCallout.displayName = "StatusCallout";

interface DialogLayerProps extends HTMLAttributes<HTMLDivElement> {
  backdropLabel: string;
  onDismiss: () => void;
}

export function DialogLayer({
  backdropLabel,
  children,
  className,
  onDismiss,
  ...props
}: DialogLayerProps) {
  return (
    <div
      className={cn(
        "app-no-drag fixed inset-0 z-[var(--layer-modal)] grid place-items-center p-5",
        className
      )}
      {...props}
    >
      <button
        aria-label={backdropLabel}
        className="app-modal-backdrop absolute inset-0"
        type="button"
        onClick={onDismiss}
      />
      <div className="relative z-[var(--layer-selection)] flex w-full justify-center">{children}</div>
    </div>
  );
}

interface SettingsSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
}

export function SettingsSection({ children, className, title, ...props }: SettingsSectionProps) {
  return (
    <section className={cn("grid gap-2", className)} {...props}>
      {title ? <h2 className="px-1 text-control font-semibold text-muted-foreground">{title}</h2> : null}
      <Surface className="settings-group overflow-hidden [&>*:last-child]:border-b-0" radius="md">
        {children}
      </Surface>
    </section>
  );
}

interface SettingsRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  control: ReactNode;
  description: ReactNode;
  showDivider?: boolean;
  title: ReactNode;
}

export function SettingsRow({
  className,
  control,
  description,
  showDivider = true,
  title,
  ...props
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        "settings-row flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        showDivider && "glass-divider border-b last:border-b-0",
        className
      )}
      {...props}
    >
      <div className="min-w-0">
        <p className="text-body font-semibold text-foreground">{title}</p>
        <div className="mt-0.5 text-control text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0 shrink-0 sm:w-auto">{control}</div>
    </div>
  );
}
