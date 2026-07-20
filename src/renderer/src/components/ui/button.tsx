import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-[12px] font-semibold leading-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-45 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-white/15 bg-primary/90 text-primary-foreground shadow-sm shadow-black/15 backdrop-blur-xl hover:bg-primary",
        destructive:
          "border-white/15 bg-destructive/90 text-destructive-foreground shadow-sm shadow-destructive/15 backdrop-blur-xl hover:bg-destructive",
        outline:
          "glass-control text-foreground hover:text-accent-foreground",
        secondary: "glass-control text-secondary-foreground hover:text-foreground",
        ghost:
          "border-transparent bg-transparent text-muted-foreground shadow-none hover:border-border/30 hover:bg-accent/35 hover:text-accent-foreground hover:backdrop-blur-xl",
        subtle: "glass-control text-foreground hover:text-foreground"
      },
      size: {
        default: "h-[30px] px-2.5",
        sm: "h-[30px] px-2.5 text-[11px]",
        lg: "h-8 px-3 text-[13px]",
        icon:
          "size-[var(--control-min-size)] shrink-0 p-0 [&>svg]:size-[var(--icon-button-icon-size)]"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, className, size, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return <Comp className={cn(buttonVariants({ className, size, variant }))} ref={ref} {...props} />;
  }
);

Button.displayName = "Button";
