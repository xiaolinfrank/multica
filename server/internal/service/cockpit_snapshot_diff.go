package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrCockpitSnapshotDiffLimit = errors.New("complete snapshot comparison exceeds 5000 nodes, 25000 payments or 2000 milestones")

var snapshotFields = map[string][]string{
	"board":     {"title", "goal_title", "goal_date", "basis", "summary_overall", "summary_next", "summary_support"},
	"node":      {"parent_id", "project_id", "module_id", "code", "name", "position", "color", "owner", "collaborators", "start_date", "end_date", "status", "progress", "deliverable", "dependencies", "note", "current_progress", "vendor", "budget_category", "budget_amount", "exec_status", "contract", "source"},
	"payment":   {"node_id", "label", "pay_date", "amount", "position"},
	"milestone": {"node_id", "name", "plan_date", "actual_date", "status", "condition", "guard", "position"},
}

func snapshotEntity(kind, id, code, name string, source any) (CockpitPlanSnapshotEntity, error) {
	entity := CockpitPlanSnapshotEntity{ID: id, Code: code, Name: name, Fields: map[string]json.RawMessage{}}
	payload, err := json.Marshal(source)
	if err != nil {
		return entity, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(payload, &fields); err != nil {
		return entity, err
	}
	for _, key := range snapshotFields[kind] {
		entity.Fields[key] = fields[key]
	}
	return entity, nil
}

// BuildCockpitPlanSnapshotIdentity consumes rows already read in one database snapshot.
// It deliberately excludes meetings, Issue relations, runs and formal acceptance facts.
func BuildCockpitPlanSnapshotIdentity(board db.Cockpit, nodes []db.CockpitNode, payments []db.CockpitPayment, milestones []db.CockpitMilestone) (*CockpitPlanSnapshotIdentity, error) {
	if len(nodes) > 5000 || len(payments) > 25000 || len(milestones) > 2000 {
		return nil, ErrCockpitSnapshotDiffLimit
	}
	out := &CockpitPlanSnapshotIdentity{SchemaVersion: 1, WorkspaceID: util.UUIDToString(board.WorkspaceID), CockpitID: util.UUIDToString(board.ID), Complete: true,
		Counts: CockpitPlanSnapshotCounts{len(nodes), len(payments), len(milestones)}, Nodes: []CockpitPlanSnapshotEntity{}, Payments: []CockpitPlanSnapshotEntity{}, Milestones: []CockpitPlanSnapshotEntity{}}
	var err error
	out.Board, err = snapshotEntity("board", out.CockpitID, "", board.Title, board)
	if err != nil {
		return nil, err
	}
	for _, row := range nodes {
		entity, e := snapshotEntity("node", util.UUIDToString(row.ID), row.Code, row.Name, row)
		if e != nil {
			return nil, e
		}
		out.Nodes = append(out.Nodes, entity)
	}
	for _, row := range payments {
		entity, e := snapshotEntity("payment", util.UUIDToString(row.ID), "", row.Label, row)
		if e != nil {
			return nil, e
		}
		out.Payments = append(out.Payments, entity)
	}
	for _, row := range milestones {
		entity, e := snapshotEntity("milestone", util.UUIDToString(row.ID), "", row.Name, row)
		if e != nil {
			return nil, e
		}
		out.Milestones = append(out.Milestones, entity)
	}
	for _, rows := range [][]CockpitPlanSnapshotEntity{out.Nodes, out.Payments, out.Milestones} {
		sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	}
	return out, nil
}

func validateSnapshotIdentity(value *CockpitPlanSnapshotIdentity, ws, board string) string {
	if value == nil {
		return "legacy_identity_missing"
	}
	if value.SchemaVersion != 1 {
		return "unsupported_identity_version"
	}
	if !value.Complete {
		return "incomplete_identity"
	}
	if value.WorkspaceID != ws || value.CockpitID != board || value.Board.ID != board || value.Nodes == nil || value.Payments == nil || value.Milestones == nil ||
		value.Counts != (CockpitPlanSnapshotCounts{len(value.Nodes), len(value.Payments), len(value.Milestones)}) {
		return "invalid_identity"
	}
	for kind, rows := range snapshotGroups(value) {
		seen := map[string]bool{}
		for _, row := range rows {
			id, err := uuid.Parse(row.ID)
			if err != nil || id == uuid.Nil || id.String() != row.ID || seen[row.ID] || len(row.Fields) != len(snapshotFields[kind]) {
				return "invalid_identity"
			}
			seen[row.ID] = true
			for _, field := range snapshotFields[kind] {
				raw, ok := row.Fields[field]
				if !ok || !json.Valid(raw) {
					return "invalid_identity"
				}
				var scalar any
				if json.Unmarshal(raw, &scalar) != nil {
					return "invalid_identity"
				}
				switch scalar.(type) {
				case nil, string, float64:
				default:
					return "invalid_identity"
				}
			}
		}
	}
	return ""
}
func snapshotGroups(value *CockpitPlanSnapshotIdentity) map[string][]CockpitPlanSnapshotEntity {
	return map[string][]CockpitPlanSnapshotEntity{"board": {value.Board}, "node": value.Nodes, "payment": value.Payments, "milestone": value.Milestones}
}
func snapshotHash(value any) string {
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func scalarEqual(left, right json.RawMessage) bool {
	if bytes.Equal(left, right) {
		return true
	}
	var a, b string
	l, r := bytes.TrimSpace(left), bytes.TrimSpace(right)
	if len(l) > 0 && len(r) > 0 && l[0] == '"' && r[0] == '"' && json.Unmarshal(l, &a) == nil && json.Unmarshal(r, &b) == nil {
		return a == b
	}
	x, ok := new(big.Rat).SetString(string(left))
	y, valid := new(big.Rat).SetString(string(right))
	return ok && valid && x.Cmp(y) == 0
}
func snapshotDiffValue(raw json.RawMessage) CockpitSnapshotDiffValue {
	if len(raw) == 0 {
		raw = json.RawMessage("null")
	}
	hash := sha256.Sum256(raw)
	out := CockpitSnapshotDiffValue{Value: raw, SHA256: hex.EncodeToString(hash[:])}
	var value string
	if json.Unmarshal(raw, &value) == nil && len([]rune(value)) > 512 {
		out.Value, _ = json.Marshal(string([]rune(value)[:512]))
		out.Truncated = true
	}
	return out
}
func snapshotLabel(value string) string {
	if len([]rune(value)) > 160 {
		return string([]rune(value)[:160]) + "…"
	}
	return value
}
func compareSnapshotPlans(before, after *CockpitPlanSnapshotIdentity) ([]CockpitSnapshotDiffItem, CockpitSnapshotDiffCounts) {
	out := []CockpitSnapshotDiffItem{}
	counts := CockpitSnapshotDiffCounts{}
	oldGroups, newGroups := snapshotGroups(before), snapshotGroups(after)
	for _, kind := range []string{"board", "node", "payment", "milestone"} {
		old, current := map[string]CockpitPlanSnapshotEntity{}, map[string]CockpitPlanSnapshotEntity{}
		for _, row := range oldGroups[kind] {
			old[row.ID] = row
		}
		for _, row := range newGroups[kind] {
			current[row.ID] = row
		}
		ids := []string{}
		for id := range old {
			ids = append(ids, id)
		}
		for id := range current {
			if _, ok := old[id]; !ok {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			a, hasOld := old[id]
			b, hasCurrent := current[id]
			display := b
			if !hasCurrent {
				display = a
			}
			item := CockpitSnapshotDiffItem{EntityKind: kind, ID: id, Code: snapshotLabel(display.Code), Name: snapshotLabel(display.Name), FieldChanges: []CockpitSnapshotFieldChange{}}
			switch {
			case !hasOld:
				item.Change = "added"
				counts.Added++
			case !hasCurrent:
				item.Change = "removed"
				counts.Removed++
			default:
				for _, field := range snapshotFields[kind] {
					if !scalarEqual(a.Fields[field], b.Fields[field]) {
						item.FieldChanges = append(item.FieldChanges, CockpitSnapshotFieldChange{field, snapshotDiffValue(a.Fields[field]), snapshotDiffValue(b.Fields[field])})
					}
				}
				if len(item.FieldChanges) == 0 {
					counts.Unchanged++
					continue
				}
				item.Change = "modified"
				counts.Modified++
			}
			out = append(out, item)
		}
	}
	return out, counts
}

type snapshotDiffCursor struct {
	WorkspaceID, SnapshotID, Token string
	PageSize                       int32
	Offset                         int
}

func (s *IssueService) GetCockpitSnapshotDiff(ctx context.Context, p CockpitSurfaceQuery, snapshotID pgtype.UUID, cursor string, size int32) (CockpitSnapshotDiff, error) {
	out := CockpitSnapshotDiff{WorkspaceID: util.UUIDToString(p.WorkspaceID), SnapshotID: util.UUIDToString(snapshotID), Scope: "workspace", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Items: []CockpitSnapshotDiffItem{}}
	if p.ProjectID.Valid || p.ModuleID.Valid {
		return out, fmt.Errorf("%w: snapshot comparisons cover the complete workspace plan", ErrCockpitWorkflowInput)
	}
	var err error
	size, err = planningPageSize(size)
	if err != nil {
		return out, err
	}
	out.PageSize = size
	if len(cursor) > 4096 {
		return out, fmt.Errorf("%w: invalid comparison cursor", ErrCockpitWorkflowInput)
	}
	var key snapshotDiffCursor
	if cursor != "" {
		raw, e := base64.RawURLEncoding.DecodeString(cursor)
		if e != nil || json.Unmarshal(raw, &key) != nil || key.WorkspaceID != out.WorkspaceID || key.SnapshotID != out.SnapshotID || key.PageSize != size || key.Offset <= 0 {
			return out, fmt.Errorf("%w: comparison cursor belongs to a different scope", ErrCockpitWorkflowInput)
		}
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	row, err := q.GetCockpitSnapshotForDiff(ctx, db.GetCockpitSnapshotForDiffParams{WorkspaceID: p.WorkspaceID, ID: snapshotID})
	if err != nil {
		return out, planningError(err)
	}
	out.SnapshotCockpitID = util.UUIDToString(row.CockpitID)
	out.SnapshotCreatedAt = row.CreatedAt.Time.UTC().Format(time.RFC3339Nano)
	if header.Cockpit != nil {
		out.CurrentCockpitID = planningUUID(header.Cockpit.ID)
	}
	var identity *CockpitPlanSnapshotIdentity
	var version struct {
		SchemaVersion int `json:"schema_version"`
	}
	if !row.ValidDocument || json.Unmarshal(row.PlanIdentity, &version) != nil {
		out.Reason = "invalid_identity"
	} else if bytes.Equal(row.PlanIdentity, []byte("null")) {
		out.Reason = "legacy_identity_missing"
	} else if version.SchemaVersion != 1 {
		out.Reason = "unsupported_identity_version"
	} else if json.Unmarshal(row.PlanIdentity, &identity) != nil {
		out.Reason = "invalid_identity"
	} else {
		out.Reason = validateSnapshotIdentity(identity, out.WorkspaceID, out.SnapshotCockpitID)
	}
	if out.Reason != "" {
		if cursor != "" {
			return out, fmt.Errorf("%w: comparison is no longer available", ErrCockpitWorkflowConflict)
		}
		return out, tx.Commit(ctx)
	}
	before := identity
	out.SnapshotComplete = before.Complete
	out.SnapshotCounts = before.Counts
	if before.Counts.Nodes > 5000 || before.Counts.Payments > 25000 || before.Counts.Milestones > 2000 {
		return out, ErrCockpitSnapshotDiffLimit
	}
	if header.Cockpit == nil {
		out.Reason = "cockpit_missing"
		if cursor != "" {
			return out, fmt.Errorf("%w: the cockpit changed; restart the comparison", ErrCockpitWorkflowConflict)
		}
		return out, tx.Commit(ctx)
	}
	if header.Cockpit.ID != row.CockpitID {
		out.Reason = "cockpit_replaced"
		if cursor != "" {
			return out, fmt.Errorf("%w: the cockpit changed; restart the comparison", ErrCockpitWorkflowConflict)
		}
		return out, tx.Commit(ctx)
	}
	payload, err := q.GetCockpitSnapshotPlanData(ctx, db.GetCockpitSnapshotPlanDataParams{WorkspaceID: p.WorkspaceID, CockpitID: row.CockpitID})
	if err != nil {
		return out, err
	}
	var data struct {
		Nodes      []db.CockpitNode      `json:"nodes"`
		Payments   []db.CockpitPayment   `json:"payments"`
		Milestones []db.CockpitMilestone `json:"milestones"`
	}
	if err = json.Unmarshal(payload, &data); err != nil {
		return out, err
	}
	after, err := BuildCockpitPlanSnapshotIdentity(*header.Cockpit, data.Nodes, data.Payments, data.Milestones)
	if err != nil {
		return out, err
	}
	out.CurrentComplete = true
	out.CurrentCounts = after.Counts
	out.Comparable = true
	out.ComparisonToken = snapshotHash([]any{before, after})
	if cursor != "" && key.Token != out.ComparisonToken {
		return out, fmt.Errorf("%w: the plan changed; restart the comparison from its first page", ErrCockpitWorkflowConflict)
	}
	items, counts := compareSnapshotPlans(before, after)
	out.Counts = counts
	out.Total = len(items)
	if key.Offset > len(items) {
		return out, fmt.Errorf("%w: invalid comparison offset", ErrCockpitWorkflowInput)
	}
	end := min(key.Offset+int(size), len(items))
	out.Items = slices.Clone(items[key.Offset:end])
	if out.Items == nil {
		out.Items = []CockpitSnapshotDiffItem{}
	}
	if end < len(items) {
		raw, _ := json.Marshal(snapshotDiffCursor{out.WorkspaceID, out.SnapshotID, out.ComparisonToken, size, end})
		value := base64.RawURLEncoding.EncodeToString(raw)
		out.NextCursor = &value
	}
	return out, tx.Commit(ctx)
}
