import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MANUAL_CREATE_FIELDS,
  DEFAULT_QUICK_CREATE_FIELDS,
  MANUAL_CREATE_FIELDS,
  QUICK_CREATE_FIELDS,
  knownFields,
  useIssueCreateSettingsStore,
} from "./issue-create-settings-store";

describe("issue create settings store", () => {
  beforeEach(() => {
    useIssueCreateSettingsStore.setState({
      quickCreateFields: DEFAULT_QUICK_CREATE_FIELDS,
      manualCreateFields: DEFAULT_MANUAL_CREATE_FIELDS,
    });
  });

  it("keeps quick create fields in canonical order regardless of toggle sequence", () => {
    const { setQuickCreateFieldVisible } = useIssueCreateSettingsStore.getState();

    setQuickCreateFieldVisible("due_date", true);
    setQuickCreateFieldVisible("priority", true);

    expect(useIssueCreateSettingsStore.getState().quickCreateFields).toEqual([
      "priority",
      "due_date",
    ]);

    setQuickCreateFieldVisible("priority", false);
    expect(useIssueCreateSettingsStore.getState().quickCreateFields).toEqual(["due_date"]);
  });

  it("toggles manual create fields independently of quick create", () => {
    const { setManualCreateFieldVisible } = useIssueCreateSettingsStore.getState();

    setManualCreateFieldVisible("labels", false);
    setManualCreateFieldVisible("due_date", true);

    expect(useIssueCreateSettingsStore.getState().manualCreateFields).toEqual([
      "status",
      "priority",
      "assignee",
      "due_date",
    ]);
    expect(useIssueCreateSettingsStore.getState().quickCreateFields).toEqual([]);
  });

  it("is a no-op to re-enable an already visible field", () => {
    const { setManualCreateFieldVisible } = useIssueCreateSettingsStore.getState();

    setManualCreateFieldVisible("status", true);

    expect(useIssueCreateSettingsStore.getState().manualCreateFields).toEqual(
      DEFAULT_MANUAL_CREATE_FIELDS,
    );
  });
});

describe("retired fields in a persisted selection", () => {
  it("drops a field this build no longer offers and keeps the canonical order", () => {
    // A build before the ownership merge stored "project" as a toggleable
    // field. It is permanent now, so the stored array must not smuggle it
    // back into the store.
    expect(
      knownFields(MANUAL_CREATE_FIELDS, ["project", "labels", "status"], DEFAULT_MANUAL_CREATE_FIELDS),
    ).toEqual(["status", "labels"]);
    expect(knownFields(QUICK_CREATE_FIELDS, ["project"], DEFAULT_QUICK_CREATE_FIELDS)).toEqual([]);
  });

  it("falls back to the defaults when nothing usable was stored", () => {
    expect(knownFields(MANUAL_CREATE_FIELDS, undefined, DEFAULT_MANUAL_CREATE_FIELDS)).toEqual(
      DEFAULT_MANUAL_CREATE_FIELDS,
    );
    // An empty array is a real answer ("everything hidden"), not a missing one.
    expect(knownFields(MANUAL_CREATE_FIELDS, [], DEFAULT_MANUAL_CREATE_FIELDS)).toEqual([]);
  });
});
