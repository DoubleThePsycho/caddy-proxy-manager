"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_TAGS_PER_HOST } from "@/lib/host-tags";

/**
 * The tags input of the proxy host and L4 host forms: a comma-separated list
 * sent as "tags". `scopeTags` are the tags of the user's role when it is
 * limited to tagged hosts; a new host then starts with the first of them.
 */
export function HostTagsField({
  defaultTags,
  scopeTags = [],
  isNew = false,
}: {
  defaultTags?: readonly string[] | null;
  scopeTags?: readonly string[];
  isNew?: boolean;
}) {
  const initial = defaultTags && defaultTags.length > 0
    ? defaultTags
    : isNew && scopeTags.length > 0 ? [scopeTags[0]] : [];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="tags">Tags</Label>
      <Input
        id="tags"
        name="tags"
        placeholder="team-a, production"
        defaultValue={initial.join(", ")}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        data-testid="host-tags"
      />
      <p className="text-xs text-muted-foreground">
        {scopeTags.length > 0
          ? `Your role manages hosts tagged ${scopeTags.join(", ")}: keep at least one of these tags. Other tags on the host stay as they are.`
          : `Comma-separated labels (letters, digits and . _ : / -), at most ${MAX_TAGS_PER_HOST}. Custom roles can be limited to hosts with given tags.`}
      </p>
    </div>
  );
}

/** A host's tags as small badges, for the host lists. */
export function HostTagBadges({ tags }: { tags: readonly string[] | undefined }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1" data-testid="host-tag-badges">
      {tags.map((tag) => (
        <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
          {tag}
        </Badge>
      ))}
    </div>
  );
}
