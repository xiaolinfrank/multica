// The meeting directory: the programme's contact book.
//
// A meeting stores parties and attendees as free text; the directory is the
// link between them — who at each unit, with their 职位. It is what lets the
// meeting form offer a unit's people once the unit is chosen, and it grows by
// itself: a person or position typed into the form is upserted when the
// meeting is saved, so they can be picked directly the next time.

import type { CockpitDirectoryEntry } from "../types";
import {
  dedupeCockpitValues,
  splitCockpitMeetingParties,
  splitCockpitMeetingPeople,
} from "./model";

/** One unit's section of the picker. */
export interface CockpitDirectoryGroup {
  party: string;
  entries: CockpitDirectoryEntry[];
}

/** The units the book knows, alphabetically. Contacts without a unit (party
 *  "") have no group; they show under the picker's other-people bucket. */
export function cockpitDirectoryParties(entries: readonly CockpitDirectoryEntry[]): string[] {
  return dedupeCockpitValues(entries.map((entry) => entry.party)).sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Every name the book knows, alphabetically — merged into the flat person
 *  suggestions so a contact is offered before their first meeting. */
export function cockpitDirectoryNames(entries: readonly CockpitDirectoryEntry[]): string[] {
  return dedupeCockpitValues(entries.map((entry) => entry.name)).sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Contacts known without their unit. */
export function cockpitDirectoryUnaffiliated(
  entries: readonly CockpitDirectoryEntry[],
): CockpitDirectoryEntry[] {
  return entries
    .filter((entry) => entry.party === "")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The picker's groups. The meeting's own parties come first, in the order the
 * field lists them — the unit someone just chose is the unit they are picking
 * from — then every other unit alphabetically. A chosen party with nobody in
 * the book has no group: there is nothing to show under it.
 */
export function cockpitDirectoryGroups(
  entries: readonly CockpitDirectoryEntry[],
  selectedParties: readonly string[],
): CockpitDirectoryGroup[] {
  const byParty = new Map<string, CockpitDirectoryEntry[]>();
  for (const entry of entries) {
    if (entry.party === "") continue;
    const list = byParty.get(entry.party) ?? [];
    list.push(entry);
    byParty.set(entry.party, list);
  }
  for (const list of byParty.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const picked = dedupeCockpitValues(selectedParties).filter((party) => byParty.has(party));
  const rest = [...byParty.keys()]
    .filter((party) => !picked.includes(party))
    .sort((a, b) => a.localeCompare(b));
  return [...picked, ...rest].map((party) => ({ party, entries: byParty.get(party)! }));
}

/**
 * A person's 职位 as the book knows it. When several units know the name, the
 * entry under one of the meeting's own parties wins; without that context the
 * first known position answers. "" means the book does not know.
 */
export function cockpitDirectoryPosition(
  entries: readonly CockpitDirectoryEntry[],
  name: string,
  parties: readonly string[] = [],
): string {
  const trimmed = name.trim();
  let fallback = "";
  for (const entry of entries) {
    if (entry.name !== trimmed) continue;
    if (entry.party !== "" && parties.includes(entry.party)) return entry.position;
    if (!fallback) fallback = entry.position;
  }
  return fallback;
}

/**
 * What the auto-save should file when a meeting is written: the attendee
 * names the book does not know at all, under the meeting's unit.
 *
 * Attribution needs exactly one party — with two units at the table there is
 * no telling who sits where, and a wrong row is worse than none. A name the
 * book already knows (under any unit) is never duplicated under this one. A
 * genuine namesake — the same name at a different unit — is filed through
 * `PUT /api/cockpit/directory` instead: the picker keys on the bare name,
 * which is all a meeting stores about a person, so it cannot tell two apart.
 * Positions are not guessed here — the server keeps an existing position when
 * the save only knows the name.
 */
export function cockpitDirectoryAutoSaveEntries(
  entries: readonly CockpitDirectoryEntry[],
  partiesValue: string,
  attendeesValue: string,
): CockpitDirectoryEntry[] {
  const parties = splitCockpitMeetingParties(partiesValue);
  const [party] = parties;
  if (parties.length !== 1 || !party) return [];
  const known = new Set(entries.map((entry) => entry.name));
  return splitCockpitMeetingPeople(attendeesValue)
    .filter((name) => !known.has(name))
    .map((name) => ({ party, name, position: "", source: "user" }));
}
