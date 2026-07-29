import * as SliderPrimitive from "@radix-ui/react-slider";
import { forwardRef } from "react";

import { cn } from "../../lib/utils";

export const Slider = forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ "aria-label": ariaLabel, className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    aria-label={ariaLabel}
    className={cn(
      "control-hit-target relative flex h-3.5 w-full touch-none select-none items-center focus-visible:outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
      className
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-0.5 w-full grow overflow-hidden rounded-full border border-border/45 bg-muted/75">
      <SliderPrimitive.Range className="absolute h-full bg-activity/80" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      aria-label={ariaLabel}
      className="block size-3.5 shrink-0 rounded-full border border-on-media/70 bg-background shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25 data-[disabled]:pointer-events-none data-[disabled]:opacity-45"
    />
  </SliderPrimitive.Root>
));

Slider.displayName = SliderPrimitive.Root.displayName;
