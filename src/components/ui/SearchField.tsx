import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { InputHTMLAttributes } from "react";

type SearchFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  /**
   * Classes of the wrapper. Without a width class the field is at most 320px
   * wide (max-w-xs); any width class (w-*, max-w-*, basis-*, grow, flex-1,
   * flex-[…], with or without a breakpoint) takes over the sizing instead.
   */
  className?: string;
};

/** A width utility, whatever its variants: the caller sizes the field. */
const WIDTH_CLASS = /^!?-?(?:w-|max-w-|basis-|grow(?:-|$)|flex-(?:1|auto|initial|\[))/;

function sizesItself(className: string | undefined): boolean {
  if (!className) return false;
  return className.split(/\s+/).some((token) => WIDTH_CLASS.test(token.slice(token.lastIndexOf(":") + 1)));
}

export function SearchField({ className, ...props }: SearchFieldProps) {
  return (
    <div className={cn("relative", !sizesItself(className) && "max-w-xs", className)}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        placeholder="Search…"
        className="pl-8"
        {...props}
      />
    </div>
  );
}
