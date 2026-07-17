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
      sm: "rounded-sm",
      md: "rounded-lg",
      lg: "rounded-lg"
    }
  },
  defaultVariants: {
    variant: "panel",
    padding: "none",
    radius: "md"
  }
});

export interface SurfaceProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceVariants> {}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, padding, radius, variant, ...props }, ref) => (
    <div ref={ref} className={cn(surfaceVariants({ className, padding, radius, variant }))} {...props} />
  )
);

Surface.displayName = "Surface";

export interface PageFrameProps extends HTMLAttributes<HTMLElement> {
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
      className={cn("app-page h-full overflow-auto px-6 py-7 md:px-10 md:py-10", className)}
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

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  description?: ReactNode;
  kicker?: ReactNode;
  title: ReactNode;
}

export function PageHeader({ actions, className, description, kicker, title, ...props }: PageHeaderProps) {
  return (
    <header className={cn("app-page-header flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between", className)} {...props}>
      <div className="min-w-0 max-w-2xl">
        {kicker ? <p className="app-page-kicker">{kicker}</p> : null}
        <h1 className="app-page-title">{title}</h1>
        {description ? <p className="app-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="app-page-actions flex w-full flex-col gap-1.5 sm:flex-row lg:w-auto">{actions}</div> : null}
    </header>
  );
}

const iconTileVariants = cva("glass-control flex shrink-0 items-center justify-center text-muted-foreground", {
  variants: {
    size: {
      sm: "h-7 w-7 rounded-md",
      md: "h-[30px] w-[30px] rounded-md",
      lg: "h-12 w-12 rounded-lg"
    }
  },
  defaultVariants: {
    size: "md"
  }
});

export interface IconTileProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof iconTileVariants> {}

export const IconTile = forwardRef<HTMLDivElement, IconTileProps>(
  ({ className, size, ...props }, ref) => (
    <div ref={ref} className={cn(iconTileVariants({ className, size }))} {...props} />
  )
);

IconTile.displayName = "IconTile";

export interface FieldHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  description?: ReactNode;
  title: ReactNode;
}

export function FieldHeader({ className, description, title, ...props }: FieldHeaderProps) {
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <p className="text-[13px] font-semibold leading-5 text-foreground">{title}</p>
      {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
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

export interface FormFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
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
  const labelClassName = "block text-[13px] font-semibold leading-5 text-foreground";

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
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export interface FormGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: 1 | 2 | 3;
}

export function FormGrid({ children, className, columns = 1, ...props }: FormGridProps) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-x-3 gap-y-3.5",
        columns === 2 && "md:grid-cols-2",
        columns === 3 && "md:grid-cols-3",
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
        "count-pill inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/30 bg-background/35 px-1 text-[10px] leading-none text-muted-foreground backdrop-blur-xl",
        className
      )}
    >
      {children}
    </span>
  );
}

export interface SegmentedItem<T extends string> {
  count?: number;
  icon?: LucideIcon;
  label: string;
  value: T;
}

export interface SegmentedControlProps<T extends string> extends HTMLAttributes<HTMLDivElement> {
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
    <Surface className={cn("grid gap-1 rounded-[8px] p-[3px]", className)} padding="none" variant="inset" {...props}>
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.value === value;

        return (
          <button
            key={item.value}
            aria-pressed={isActive}
            disabled={disabled}
            className={cn(
              "flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-[5px] border border-transparent px-3 text-[11px] font-semibold leading-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-45",
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

export interface NavItemProps {
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
      {typeof count === "number" ? <CountPill className="h-5 min-w-5 px-1.5 text-[11px]">{count}</CountPill> : null}
      {showStatusDot ? (
        <span
          aria-label={statusDotLabel}
          className="size-2 shrink-0 rounded-full bg-blue-500 ring-2 ring-blue-500/15"
          role={statusDotLabel ? "status" : undefined}
        />
      ) : null}
    </>
  );
  const itemClassName = cn(
    noDrag && "app-no-drag",
    "nav-item flex h-8 items-center gap-2 rounded-md border border-transparent px-2.5 text-left text-[13px] font-medium leading-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20",
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
