// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { OrganizationViewOption } from "@/ee/multi-tenancy/types";

export type OrganizationSwitcherProps = {
  /** "all", "provider" or an organisation id. */
  value: string;
  options: OrganizationViewOption[];
  /** Stores the view (a server action); it grants nothing. */
  onChange: (value: string) => Promise<void>;
};

/** Which organisation the dashboard shows a provider-level user (ee/multi-tenancy). */
export function OrganizationSwitcher({ value, options, onChange }: OrganizationSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="px-3 pt-3">
      <Select
        value={value}
        disabled={pending}
        onValueChange={(next) =>
          startTransition(async () => {
            await onChange(next);
            router.refresh();
          })
        }
      >
        <SelectTrigger className="h-8 text-xs" aria-label="Organisation shown" data-testid="organization-switcher">
          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The organisation an organisation user belongs to, shown under the product name. */
export function OrganizationBadge({ name }: { name: string }) {
  return (
    <div className="px-4 pt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="organization-name">
      <Building2 className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </div>
  );
}
