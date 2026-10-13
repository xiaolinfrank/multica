package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

func artifactCLIMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func artifactCLIUUIDs(body map[string]any, required, optional []string) error {
	for _, field := range append(append([]string{}, required...), optional...) {
		value, exists := body[field]
		if !exists && slices.Contains(optional, field) {
			continue
		}
		id, err := cockpitWorkflowUUID(strVal(body, field), field)
		if err != nil || value == nil {
			return fmt.Errorf("%s must be a nonempty UUID", field)
		}
		body[field] = id
	}
	return nil
}

func artifactCLIText(body map[string]any, field string, required bool, limit int) error {
	value, ok := body[field].(string)
	if !ok {
		return fmt.Errorf("%s must be a string", field)
	}
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || len(value) > limit || required && value == "" {
		return fmt.Errorf("%s must be valid UTF-8 within %d bytes%s", field, limit, map[bool]string{true: " and nonempty"}[required])
	}
	body[field] = value
	return nil
}

func validateCockpitArtifactCLICommand(action string, acceptance bool, body map[string]any) error {
	fields := map[string]string{
		"create": "creation_key node_id source_issue_id title description reviewer_id",
		"edit":   "expected_revision title description", "submit": "expected_revision submission_key producer_issue_id payload source_meeting_id source_minutes_version_id",
		"review": "expected_revision decision feedback", "retry-capture": "expected_revision", "archive": "expected_revision", "unarchive": "expected_revision",
		"assign-producer": "expected_revision command_key reason issue_id new_issue", "reassign-reviewer": "expected_revision handoff_key reviewer_id reason",
		"reference-node": "reference_key version_id node_id purpose",
		"save-criteria":  "expected_revision criteria",
	}
	if acceptance && action == "submit" {
		fields[action] = "request_key expected_criteria_revision reviewer_id evidence note supersedes_request_id"
	}
	allowed := strings.Fields(fields[action])
	for field := range body {
		if !slices.Contains(allowed, field) {
			return fmt.Errorf("unsupported command field %q", field)
		}
	}
	if slices.Contains(allowed, "expected_revision") {
		minimum := float64(1)
		if action == "save-criteria" {
			minimum = 0
		}
		if !cockpitReceiptNumber(body["expected_revision"], minimum) {
			return fmt.Errorf("expected_revision must be an observed integer revision")
		}
	}
	if action == "review" {
		decision := strVal(body, "decision")
		if !slices.Contains([]string{"approved", "changes_requested", "rejected"}, decision) {
			return fmt.Errorf("decision must be approved, changes_requested or rejected")
		}
		return artifactCLIText(body, "feedback", decision != "approved", 16000)
	}
	if action == "reassign-reviewer" || action == "assign-producer" {
		if err := artifactCLIText(body, "reason", true, 16000); err != nil {
			return err
		}
		if action == "reassign-reviewer" {
			return artifactCLIUUIDs(body, []string{"handoff_key", "reviewer_id"}, nil)
		}
		if err := artifactCLIUUIDs(body, []string{"command_key"}, nil); err != nil {
			return err
		}
		_, hasIssue := body["issue_id"]
		_, hasNew := body["new_issue"]
		if hasIssue == hasNew {
			return fmt.Errorf("choose exactly one of issue_id and new_issue")
		}
		if hasIssue {
			return artifactCLIUUIDs(body, []string{"issue_id"}, nil)
		}
		return validateArtifactNewProducer(artifactCLIMap(body["new_issue"]))
	}
	if action == "create" || action == "edit" {
		if err := artifactCLIText(body, "title", true, 2000); err != nil {
			return err
		}
		if utf8.RuneCountInString(strVal(body, "title")) > 500 {
			return fmt.Errorf("title exceeds 500 characters")
		}
		if err := artifactCLIText(body, "description", false, 16000); err != nil {
			return err
		}
		if action == "create" {
			return artifactCLIUUIDs(body, []string{"creation_key", "node_id", "source_issue_id", "reviewer_id"}, nil)
		}
	}
	if strings.HasPrefix(action, "reference-") {
		target := "node_id"
		if !slices.Contains([]string{"input", "output", "evidence", "reference"}, strVal(body, "purpose")) {
			return fmt.Errorf("purpose must be input, output, evidence or reference")
		}
		return artifactCLIUUIDs(body, []string{"reference_key", "version_id", target}, nil)
	}
	if action == "submit" && !acceptance {
		if err := artifactCLIUUIDs(body, []string{"submission_key", "producer_issue_id"}, []string{"source_meeting_id", "source_minutes_version_id"}); err != nil {
			return err
		}
		if body["source_minutes_version_id"] != nil && body["source_meeting_id"] == nil {
			return fmt.Errorf("source_minutes_version_id requires source_meeting_id")
		}
		payload := artifactCLIMap(body["payload"])
		if len(payload) != 2 {
			return fmt.Errorf("payload requires kind and exactly one of content or attachment_id")
		}
		switch payload["kind"] {
		case "text":
			content, ok := payload["content"].(string)
			if !ok || !utf8.ValidString(content) || strings.TrimSpace(content) == "" || len(content) > 128<<10 {
				return fmt.Errorf("payload.content must be nonempty UTF-8 text of at most 128 KiB")
			}
		case "attachment":
			return artifactCLIUUIDs(payload, []string{"attachment_id"}, nil)
		default:
			return fmt.Errorf("payload.kind must be text or attachment")
		}
	}
	if action == "submit" && acceptance {
		if err := artifactCLIUUIDs(body, []string{"request_key", "reviewer_id"}, []string{"supersedes_request_id"}); err != nil {
			return err
		}
		if !cockpitReceiptNumber(body["expected_criteria_revision"], 1) {
			return fmt.Errorf("expected_criteria_revision must identify the observed criteria")
		}
		if err := artifactCLIText(body, "note", false, 16000); err != nil {
			return err
		}
		return validateArtifactEvidence(body["evidence"])
	}
	if action == "save-criteria" {
		items, ok := body["criteria"].([]any)
		if !ok || len(items) > 50 {
			return fmt.Errorf("criteria must be an array of at most 50 items")
		}
		seen := map[string]bool{}
		for _, item := range items {
			criterion := artifactCLIMap(item)
			if len(criterion) != 3 || artifactCLIUUIDs(criterion, []string{"id"}, nil) != nil || artifactCLIText(criterion, "title", true, 2000) != nil || artifactCLIText(criterion, "description", false, 16000) != nil || seen[strVal(criterion, "id")] {
				return fmt.Errorf("criteria require distinct UUIDs, nonempty titles and descriptions")
			}
			seen[strVal(criterion, "id")] = true
		}
	}
	return nil
}

func validateArtifactNewProducer(issue map[string]any) error {
	for field := range issue {
		if !slices.Contains([]string{"title", "description", "assignee_type", "assignee_id", "priority", "due_date"}, field) {
			return fmt.Errorf("unsupported new_issue field %q", field)
		}
	}
	if artifactCLIText(issue, "title", true, 2000) != nil || artifactCLIText(issue, "description", false, 16000) != nil {
		return fmt.Errorf("new_issue requires title and description")
	}
	if issue["assignee_type"] != nil || issue["assignee_id"] != nil {
		if !slices.Contains([]string{"member", "agent", "squad"}, strVal(issue, "assignee_type")) || artifactCLIUUIDs(issue, []string{"assignee_id"}, nil) != nil {
			return fmt.Errorf("new_issue assignee_type and assignee_id must form a complete assignment")
		}
	}
	if priority, ok := issue["priority"]; ok && !slices.Contains([]string{"none", "urgent", "high", "medium", "low"}, fmt.Sprint(priority)) {
		return fmt.Errorf("unsupported new_issue priority")
	}
	if issue["due_date"] != nil {
		if _, err := time.Parse("2006-01-02", strVal(issue, "due_date")); err != nil {
			return fmt.Errorf("new_issue due_date requires YYYY-MM-DD or null")
		}
	}
	return nil
}

func validateArtifactEvidence(value any) error {
	items, ok := value.([]any)
	if !ok || len(items) == 0 || len(items) > 50 {
		return fmt.Errorf("evidence requires 1-50 criteria")
	}
	criteria, versions := map[string]bool{}, map[string]bool{}
	for _, raw := range items {
		item := artifactCLIMap(raw)
		id := cockpitNASReceiptUUID(item["criterion_id"])
		ids, ok := item["version_ids"].([]any)
		if len(item) != 2 || id == "" || criteria[id] || !ok || len(ids) == 0 || len(ids) > 20 {
			return fmt.Errorf("each distinct criterion requires 1-20 distinct version UUIDs")
		}
		criteria[id], item["criterion_id"] = true, id
		seen := map[string]bool{}
		for i, rawID := range ids {
			version := cockpitNASReceiptUUID(rawID)
			if version == "" || seen[version] {
				return fmt.Errorf("evidence version UUID is empty, invalid or repeated")
			}
			seen[version], versions[version], ids[i] = true, true, version
		}
	}
	if len(versions) > 200 {
		return fmt.Errorf("evidence exceeds 200 distinct versions")
	}
	return nil
}

func artifactCLIHash(value any) bool {
	text, ok := value.(string)
	decoded, err := hex.DecodeString(text)
	return ok && err == nil && len(decoded) == 32 && text == strings.ToLower(text)
}

func artifactCLIVersion(value any, artifactID string) bool {
	v := artifactCLIMap(value)
	if cockpitNASReceiptUUID(v["id"]) == "" || v["artifact_id"] != artifactID || !cockpitReceiptNumber(v["version_number"], 1) || !cockpitReceiptNumber(v["revision"], 1) || cockpitNASReceiptUUID(v["submission_key"]) == "" || cockpitNASReceiptUUID(v["producer_issue_id"]) == "" {
		return false
	}
	_, hasContent := v["content"]
	_, hasFeedback := v["feedback"]
	if hasContent || hasFeedback {
		return false
	}
	if v["capture_status"] == "ready" && (!artifactCLIHash(v["content_hash"]) || !cockpitReceiptNumber(v["size_bytes"], 0)) {
		return false
	}
	if slices.Contains([]string{"pending", "approved", "changes_requested", "rejected"}, strVal(v, "decision")) {
		return v["capture_status"] == "ready" && cockpitNASReceiptUUID(artifactCLIMap(v["review_issue"])["id"]) != ""
	}
	return strVal(v, "capture_status") != "" && strVal(v, "decision") != ""
}

func artifactCLIHeader(v map[string]any, wsID, artifactID string) bool {
	if artifactID == "" {
		artifactID = cockpitNASReceiptUUID(v["id"])
	}
	if artifactID == "" || v["id"] != artifactID || v["workspace_id"] != wsID || !cockpitReceiptNumber(v["revision"], 1) || cockpitNASReceiptUUID(v["node_id"]) == "" || cockpitNASReceiptUUID(v["creation_key"]) == "" || cockpitNASReceiptUUID(artifactCLIMap(v["source_issue"])["id"]) == "" || cockpitNASReceiptUUID(artifactCLIMap(v["producer_issue"])["id"]) == "" {
		return false
	}
	for _, field := range []string{"current_version", "approved_version", "evidence_version"} {
		pin, exists := v[field]
		if !exists || pin != nil && !artifactCLIVersion(pin, artifactID) {
			return false
		}
		if field != "current_version" && pin != nil && artifactCLIMap(pin)["decision"] != "approved" {
			return false
		}
	}
	return true
}

func confirmCockpitArtifactCLIReceipt(op cockpitArtifactOperation, acceptance bool, ids []string, query url.Values, size int, body, result map[string]any, wsID string) bool {
	if result["workspace_id"] != wsID {
		return false
	}
	ownerID := ""
	if len(ids) > 0 {
		ownerID = ids[0]
	}
	if op.page {
		items, ok := result["items"].([]any)
		cursor, hasCursor := result["next_cursor"]
		cursorText, stringCursor := cursor.(string)
		if !ok || len(items) > size || !cockpitReceiptNumber(result["total"], float64(len(items))) || !hasCursor || cursor != nil && (!stringCursor || cursorText == "" || cursorText == query.Get("cursor")) {
			return false
		}
		field := "artifact_id"
		if acceptance {
			field = "node_id"
		}
		if ownerID != "" && result[field] != ownerID {
			return false
		}
		if op.name == "list" {
			scope := artifactCLIMap(result["scope"])
			selected, ok := scope["ids"].([]any)
			selectedIDs := []string{}
			for _, raw := range selected {
				id := cockpitNASReceiptUUID(raw)
				if id == "" || slices.Contains(selectedIDs, id) {
					return false
				}
				selectedIDs = append(selectedIDs, id)
			}
			slices.Sort(selectedIDs)
			if !ok || strings.Join(selectedIDs, ",") != query.Get("ids") {
				return false
			}
			for _, field := range []string{"project_id", "module_id", "node_id", "source_issue_id"} {
				if query.Get(field) != "" && scope[field] != query.Get(field) || query.Get(field) == "" && scope[field] != nil {
					return false
				}
			}
			if scope["q"] != query.Get("q") || scope["status"] != query.Get("status") || scope["relation"] != query.Get("relation") || !cockpitReceiptNumber(result["filtered_total"], float64(len(items))) {
				return false
			}
		}
		seen := map[string]bool{}
		for _, raw := range items {
			item := artifactCLIMap(raw)
			id := cockpitNASReceiptUUID(item["id"])
			if id == "" || seen[id] {
				return false
			}
			seen[id] = true
			if op.name == "list" && !artifactCLIHeader(item, wsID, id) || op.name == "versions" && !artifactCLIVersion(item, ownerID) {
				return false
			}
			if op.name == "list" {
				if query.Get("ids") != "" && !slices.Contains(strings.Split(query.Get("ids"), ","), id) {
					return false
				}
				if query.Get("relation") == "owned" {
					for _, field := range []string{"project_id", "module_id", "node_id"} {
						if query.Get(field) != "" && item[field] != query.Get(field) {
							return false
						}
					}
				}
			}
			if op.name != "list" && op.name != "attachments" && item[field] != ownerID {
				return false
			}
			if op.name == "attachments" && item["source_issue_id"] != result["producer_issue_id"] {
				return false
			}
		}
		return op.name != "attachments" || result["q"] == query.Get("q") && cockpitNASReceiptUUID(result["producer_issue_id"]) != ""
	}
	if acceptance {
		return confirmCockpitAcceptanceCLIReceipt(op.name, ids, body, result, wsID)
	}
	if slices.Contains([]string{"show", "create", "edit", "archive", "unarchive"}, op.name) {
		if !artifactCLIHeader(result, wsID, ownerID) {
			return false
		}
		switch op.name {
		case "create":
			return result["creation_key"] == body["creation_key"] && result["node_id"] == body["node_id"] && artifactCLIMap(result["source_issue"])["id"] == body["source_issue_id"]
		case "edit":
			return result["title"] == body["title"] && result["description"] == body["description"]
		case "archive", "unarchive":
			return (result["archived_at"] != nil) == (op.name == "archive")
		}
		return true
	}
	if op.name == "assign-producer" || op.name == "reassign-reviewer" {
		if !artifactCLIHeader(artifactCLIMap(result["artifact"]), wsID, ownerID) {
			return false
		}
		if op.name == "assign-producer" {
			receipt := artifactCLIMap(result["assignment"])
			return receipt["artifact_id"] == ownerID && receipt["command_key"] == body["command_key"] && receipt["reason"] == body["reason"] && cockpitNASReceiptUUID(receipt["to_issue_id"]) != "" && receipt["to_issue_id"] == artifactCLIMap(result["to_issue"])["id"] && (body["issue_id"] == nil || receipt["to_issue_id"] == body["issue_id"])
		}
		return artifactCLIHandoff(artifactCLIMap(result["handoff"]), body, "artifact_id", ownerID)
	}
	if strings.Contains(op.name, "reference") {
		reference := artifactCLIMap(result["reference"])
		if reference["artifact_id"] != ownerID || cockpitNASReceiptUUID(reference["id"]) == "" {
			return false
		}
		if op.method == "DELETE" {
			return reference["id"] == ids[1] && cockpitHistoryTimestamp(reference["removed_at"])
		}
		target := "node_id"
		return reference["reference_key"] == body["reference_key"] && reference["version_id"] == body["version_id"] && reference[target] == body[target] && reference["purpose"] == body["purpose"] && artifactCLIHash(reference["content_hash"])
	}
	if op.name == "download-link" {
		stamp, err := time.Parse(time.RFC3339Nano, strVal(result, "expires_at"))
		link, linkErr := url.Parse(strVal(result, "url"))
		if linkErr != nil || link.User != nil || link.Fragment != "" || link.Path != "/api/cockpit/artifact-files/"+ids[1]+"/download" || len(link.Query()["token"]) != 1 || link.Query().Get("token") == "" || len(link.Query()) != 1 {
			return false
		}
		return result["artifact_id"] == ownerID && result["version_id"] == ids[1] && err == nil && stamp.After(time.Now()) && ((link.Scheme == "https" || link.Scheme == "http") && link.Host != "" || link.Scheme == "" && link.Host == "")
	}
	detail := result
	if op.method != "GET" {
		if !artifactCLIHeader(artifactCLIMap(result["artifact"]), wsID, ownerID) {
			return false
		}
		detail = artifactCLIMap(result["version"])
	}
	version := artifactCLIMap(detail["version"])
	if detail["workspace_id"] != wsID || detail["artifact_id"] != ownerID || !artifactCLIVersion(version, ownerID) || len(ids) > 1 && version["id"] != ids[1] {
		return false
	}
	available, hasAvailability := detail["content_available"].(bool)
	if !hasAvailability {
		return false
	}
	if available && version["payload_kind"] == "text" {
		if _, ok := detail["content"].(string); !ok {
			return false
		}
	}
	if op.name == "submit" {
		payload := artifactCLIMap(body["payload"])
		if version["submission_key"] != body["submission_key"] || version["producer_issue_id"] != body["producer_issue_id"] || version["payload_kind"] != payload["kind"] || version["source_meeting_id"] != body["source_meeting_id"] || version["source_minutes_version_id"] != body["source_minutes_version_id"] {
			return false
		}
		if payload["kind"] == "text" {
			hash := sha256.Sum256([]byte(strVal(payload, "content")))
			return detail["content"] == payload["content"] && version["content_hash"] == hex.EncodeToString(hash[:])
		}
		return version["source_attachment_id"] == payload["attachment_id"]
	}
	return op.name != "review" || version["decision"] == body["decision"] && detail["feedback"] == body["feedback"] && cockpitHistoryTimestamp(version["reviewed_at"])
}

func artifactCLIHandoff(receipt, body map[string]any, field, ownerID string) bool {
	return cockpitNASReceiptUUID(receipt["id"]) != "" && receipt[field] == ownerID && receipt["handoff_key"] == body["handoff_key"] && receipt["to_reviewer_id"] == body["reviewer_id"] && receipt["reason"] == body["reason"]
}

func confirmCockpitAcceptanceCLIReceipt(action string, ids []string, body, result map[string]any, wsID string) bool {
	if action == "reassign-reviewer" {
		handoff := artifactCLIMap(result["handoff"])
		request := artifactCLIMap(result["request"])
		return artifactCLIHandoff(handoff, body, "node_id", ids[0]) && handoff["request_id"] == ids[1] && artifactCLIMap(result["acceptance"])["workspace_id"] == wsID && request["workspace_id"] == wsID && request["node_id"] == ids[0] && artifactCLIMap(request["request"])["id"] == ids[1]
	}
	if result["node_id"] != ids[0] {
		return false
	}
	if action == "show" {
		return cockpitReceiptNumber(result["criteria_revision"], 0) && cockpitReceiptNumber(result["request_count"], 0)
	}
	if action == "criteria" || action == "save-criteria" {
		items, ok := result["items"].([]any)
		if !ok || len(items) > 50 || !cockpitReceiptNumber(result["revision"], 0) {
			return false
		}
		if action == "criteria" {
			return true
		}
		want := body["criteria"].([]any)
		if len(items) != len(want) {
			return false
		}
		for i, raw := range items {
			row, expected := artifactCLIMap(raw), artifactCLIMap(want[i])
			if row["id"] != expected["id"] || row["title"] != expected["title"] || row["description"] != expected["description"] {
				return false
			}
		}
		return true
	}
	request := artifactCLIMap(result["request"])
	if cockpitNASReceiptUUID(request["id"]) == "" || request["node_id"] != ids[0] || !artifactCLIHash(request["evidence_hash"]) || len(ids) > 1 && request["id"] != ids[1] {
		return false
	}
	if action == "review" {
		return request["decision"] == body["decision"] && result["feedback"] == body["feedback"] && cockpitHistoryTimestamp(request["reviewed_at"])
	}
	if action != "submit" {
		return true
	}
	if request["request_key"] != body["request_key"] || request["criteria_revision"] != body["expected_criteria_revision"] || result["note"] != body["note"] || request["supersedes_request_id"] != body["supersedes_request_id"] {
		return false
	}
	expected, actual := map[string][]string{}, map[string][]string{}
	for _, raw := range body["evidence"].([]any) {
		entry := artifactCLIMap(raw)
		for _, version := range entry["version_ids"].([]any) {
			expected[strVal(entry, "criterion_id")] = append(expected[strVal(entry, "criterion_id")], version.(string))
		}
		slices.Sort(expected[strVal(entry, "criterion_id")])
	}
	evidence, ok := result["evidence"].([]any)
	if !ok {
		return false
	}
	for _, raw := range evidence {
		entry := artifactCLIMap(raw)
		criterion := strVal(artifactCLIMap(entry["criterion"]), "id")
		versions, ok := entry["versions"].([]any)
		if !ok || actual[criterion] != nil {
			return false
		}
		for _, rawVersion := range versions {
			version := artifactCLIMap(rawVersion)
			if !artifactCLIVersion(version, strVal(version, "artifact_id")) || version["decision"] != "approved" {
				return false
			}
			actual[criterion] = append(actual[criterion], strVal(version, "id"))
		}
		slices.Sort(actual[criterion])
	}
	return reflect.DeepEqual(expected, actual)
}
