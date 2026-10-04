import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** Pills (System.dc.html): 22px high, fully rounded, tinted by meaning. */
const badgeVariants = cva(
  "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-brand-tint text-brand",
        secondary: "border-transparent bg-raise text-muted-foreground",
        destructive: "border-transparent bg-bad-tint text-bad",
        outline: "border-line2 text-foreground",
        success: "border-transparent bg-ok-tint text-ok",
        warning: "border-transparent bg-warn-tint text-warn",
        info: "border-transparent bg-brand-tint text-brand",
        muted: "border-transparent bg-raise text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
