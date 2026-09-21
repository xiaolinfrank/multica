"use client";

// Meeting people, and which of them the platform knows.
//
// A meeting's organiser and attendees are names in a text field, because half
// the room at a joint meeting has no account here and a field that only took
// members would be a field nobody could fill in truthfully. What the platform
// CAN do is recognise its own: a name that matches a workspace member is
// shown as that member — avatar, and their address where there is room — and
// everyone else reads as a plain name.
//
// The match is on the display name, which is what the field stores. That is a
// soft link on purpose: renaming an account does not rewrite history, and a
// meeting minute that says "杨涛" goes on saying it.

import { useMemo } from "react";
import type { MemberWithUser } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";

export interface CockpitPeople {
  /** Member display names, in the order the workspace lists them. */
  names: string[];
  byName: Map<string, MemberWithUser>;
}

export function useCockpitPeople(members: MemberWithUser[]): CockpitPeople {
  return useMemo(() => {
    const byName = new Map<string, MemberWithUser>();
    const names: string[] = [];
    for (const member of members) {
      const name = member.name.trim();
      // Two accounts with the same display name: the first one wins the
      // avatar rather than the list showing the name twice.
      if (!name || byName.has(name)) continue;
      byName.set(name, member);
      names.push(name);
    }
    return { names, byName };
  }, [members]);
}

/** The person's initial, or their picture when the account has one. */
function PersonAvatar({ member, name }: { member?: MemberWithUser; name: string }) {
  if (member?.avatar_url) {
    return (
      <img
        src={member.avatar_url}
        alt=""
        className="size-4 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full text-[0.5rem] leading-none",
        member ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground",
      )}
    >
      {[...name.trim()][0] ?? "?"}
    </span>
  );
}

export function CockpitPersonLabel({
  name,
  member,
  withEmail,
  chip,
}: {
  name: string;
  member?: MemberWithUser;
  /** Show the account's address, to tell two people of the same name apart. */
  withEmail?: boolean;
  /** Render as a chip, for a list of attendees rather than one organiser. */
  chip?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-caption",
        chip && "rounded-full bg-muted py-px pr-1.5 pl-px",
      )}
    >
      <PersonAvatar member={member} name={name} />
      <span className="truncate">{name}</span>
      {withEmail && member && (
        <span className="max-w-32 truncate text-micro text-muted-foreground">{member.email}</span>
      )}
    </span>
  );
}
