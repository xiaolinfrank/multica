package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type CockpitMeetingTemplateQuery struct {
	WorkspaceID, ActorID, TemplateID, VersionID pgtype.UUID
	Human, IncludeInactive                      bool
	Query, Cursor                               string
	PageSize                                    int32
}

func templateManager(human bool, actor, creator pgtype.UUID, role string) bool {
	return human && (actor == creator || role == "owner" || role == "admin")
}

func templateHeader(r db.GetCockpitMeetingTemplateHeaderRow, p CockpitMeetingTemplateQuery, role string) CockpitMeetingTemplateHeader {
	t := r.CockpitMeetingTemplate
	return CockpitMeetingTemplateHeader{WorkspaceID: util.UUIDToString(t.WorkspaceID), ID: util.UUIDToString(t.ID), Revision: t.Revision,
		Title: t.Title, Description: t.Description, Active: t.IsActive, CreatedBy: util.UUIDToString(t.CreatedBy), CreatedAt: t.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: t.UpdatedAt.Time.UTC().Format(time.RFC3339Nano),
		CanEdit: templateManager(p.Human, p.ActorID, t.CreatedBy, role),
		CurrentVersion: CockpitMeetingTemplateVersionMetadata{ID: util.UUIDToString(t.CurrentVersionID), TemplateID: util.UUIDToString(t.ID), Number: r.Number, Title: t.Title, Active: t.IsActive,
			SlotCount: r.SlotCount, ConfigHash: r.ConfigHash, CommandKey: util.UUIDToString(r.CommandKey), CreatedBy: util.UUIDToString(r.VersionCreatedBy), CreatedByName: r.VersionCreatedByName, CreatedAt: r.VersionCreatedAt.Time.UTC().Format(time.RFC3339Nano)}}
}

func readTemplateHeader(ctx context.Context, q *db.Queries, p CockpitMeetingTemplateQuery, role string) (CockpitMeetingTemplateHeader, error) {
	r, e := q.GetCockpitMeetingTemplateHeader(ctx, db.GetCockpitMeetingTemplateHeaderParams{WorkspaceID: p.WorkspaceID, ID: p.TemplateID})
	if e != nil {
		return CockpitMeetingTemplateHeader{}, cockpitWorkflowError(e)
	}
	return templateHeader(r, p, role), nil
}

func (s *IssueService) beginTemplateRead(ctx context.Context, p CockpitMeetingTemplateQuery) (pgx.Tx, *db.Queries, string, error) {
	tx, q, e := s.beginPlanningRead(ctx)
	if e != nil {
		return nil, nil, "", e
	}
	m, e := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if e != nil {
		_ = tx.Rollback(ctx)
		if errors.Is(e, pgx.ErrNoRows) {
			e = ErrCockpitWorkflowForbidden
		}
		return nil, nil, "", e
	}
	return tx, q, m.Role, nil
}

func (s *IssueService) GetCockpitMeetingTemplate(ctx context.Context, p CockpitMeetingTemplateQuery) (CockpitMeetingTemplateHeader, error) {
	tx, q, role, e := s.beginTemplateRead(ctx, p)
	if e != nil {
		return CockpitMeetingTemplateHeader{}, e
	}
	defer tx.Rollback(ctx)
	return readTemplateHeader(ctx, q, p, role)
}

func (s *IssueService) ListCockpitMeetingTemplates(ctx context.Context, p CockpitMeetingTemplateQuery) (CockpitMeetingTemplatePage, error) {
	var out CockpitMeetingTemplatePage
	p.Query = strings.TrimSpace(p.Query)
	if len(p.Query) > 512 {
		return out, ErrCockpitWorkflowInput
	}
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	scope := planningHash([]any{"meeting_templates", p.WorkspaceID, p.Query, p.IncludeInactive, size})
	_, after, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil {
		return out, e
	}
	tx, q, role, e := s.beginTemplateRead(ctx, p)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	total, e := q.CountCockpitMeetingTemplates(ctx, db.CountCockpitMeetingTemplatesParams{WorkspaceID: p.WorkspaceID, IncludeInactive: p.IncludeInactive, Query: p.Query})
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitMeetingTemplates(ctx, db.ListCockpitMeetingTemplatesParams{WorkspaceID: p.WorkspaceID, IncludeInactive: p.IncludeInactive, Query: p.Query, AfterID: after, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitMeetingTemplatePage{WorkspaceID: util.UUIDToString(p.WorkspaceID), Query: p.Query, IncludeInactive: p.IncludeInactive, PageSize: size, Items: []CockpitMeetingTemplateHeader{}, Total: total, CanCreate: p.Human}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(rows[len(rows)-1].CockpitMeetingTemplate.ID)})
	}
	for _, r := range rows {
		out.Items = append(out.Items, templateHeader(db.GetCockpitMeetingTemplateHeaderRow(r), p, role))
	}
	return out, nil
}

func readTemplateVersionReceipt(v db.CockpitMeetingTemplateVersion) (CockpitMeetingTemplateVersionDetail, error) {
	var d CockpitMeetingTemplateVersionDetail
	if e := json.Unmarshal(v.Receipt, &d); e != nil {
		return d, e
	}
	if d.ID != util.UUIDToString(v.ID) || d.TemplateID != util.UUIDToString(v.TemplateID) || d.WorkspaceID != util.UUIDToString(v.WorkspaceID) || d.CommandKey != util.UUIDToString(v.CommandKey) || d.ConfigHash != v.ConfigHash {
		return d, fmt.Errorf("template receipt identity does not match the fixed version")
	}
	return d, nil
}

func (s *IssueService) GetCockpitMeetingTemplateVersion(ctx context.Context, p CockpitMeetingTemplateQuery) (CockpitMeetingTemplateVersionDetail, error) {
	tx, q, _, e := s.beginTemplateRead(ctx, p)
	if e != nil {
		return CockpitMeetingTemplateVersionDetail{}, e
	}
	defer tx.Rollback(ctx)
	v, e := q.GetCockpitMeetingTemplateVersion(ctx, db.GetCockpitMeetingTemplateVersionParams{WorkspaceID: p.WorkspaceID, TemplateID: p.TemplateID, ID: p.VersionID})
	if e != nil {
		return CockpitMeetingTemplateVersionDetail{}, cockpitWorkflowError(e)
	}
	return readTemplateVersionReceipt(v)
}

func (s *IssueService) ListCockpitMeetingTemplateVersions(ctx context.Context, p CockpitMeetingTemplateQuery) (CockpitMeetingTemplateVersionPage, error) {
	var out CockpitMeetingTemplateVersionPage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	scope := planningHash([]any{"meeting_template_versions", p.WorkspaceID, p.TemplateID, size})
	c, after, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil || c.Order > math.MaxInt32 || c.Order < 0 {
		return out, ErrCockpitWorkflowInput
	}
	tx, q, role, e := s.beginTemplateRead(ctx, p)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if _, e = readTemplateHeader(ctx, q, p, role); e != nil {
		return out, e
	}
	count, e := q.CountCockpitMeetingTemplateVersions(ctx, db.CountCockpitMeetingTemplateVersionsParams{WorkspaceID: p.WorkspaceID, TemplateID: p.TemplateID})
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitMeetingTemplateVersions(ctx, db.ListCockpitMeetingTemplateVersionsParams{WorkspaceID: p.WorkspaceID, TemplateID: p.TemplateID, AfterID: after, AfterNumber: int32(c.Order), PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitMeetingTemplateVersionPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), TemplateID: util.UUIDToString(p.TemplateID), PageSize: size, Items: []CockpitMeetingTemplateVersionMetadata{}, Total: count}
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(last.ID), Order: int64(last.Number)})
	}
	for _, r := range rows {
		out.Items = append(out.Items, CockpitMeetingTemplateVersionMetadata{ID: util.UUIDToString(r.ID), TemplateID: util.UUIDToString(r.TemplateID), Number: r.Number, Title: r.Title, Active: r.IsActive, SlotCount: r.SlotCount, ConfigHash: r.ConfigHash, CommandKey: util.UUIDToString(r.CommandKey), CreatedBy: util.UUIDToString(r.CreatedBy), CreatedByName: r.CreatedByName, CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano)})
	}
	return out, nil
}

func templateSaveResult(ctx context.Context, q *db.Queries, p CockpitMeetingTemplateQuery, role string, v db.CockpitMeetingTemplateVersion, replayed bool) (CockpitMeetingTemplateSaveResult, error) {
	d, e := readTemplateVersionReceipt(v)
	if e != nil {
		return CockpitMeetingTemplateSaveResult{}, e
	}
	p.TemplateID = v.TemplateID
	h, e := readTemplateHeader(ctx, q, p, role)
	if e != nil {
		if errors.Is(e, ErrCockpitWorkflowNotFound) {
			e = ErrCockpitLifecycleGone
		}
		return CockpitMeetingTemplateSaveResult{}, e
	}
	return CockpitMeetingTemplateSaveResult{WorkspaceID: d.WorkspaceID, TemplateID: d.TemplateID, CommandKey: d.CommandKey, RequestHash: v.RequestHash, Replayed: replayed, Receipt: d, Current: h}, nil
}

func (s *IssueService) GetCockpitMeetingTemplateCommand(ctx context.Context, p CockpitMeetingTemplateQuery, key pgtype.UUID) (CockpitMeetingTemplateSaveResult, error) {
	tx, q, role, e := s.beginTemplateRead(ctx, p)
	if e != nil {
		return CockpitMeetingTemplateSaveResult{}, e
	}
	defer tx.Rollback(ctx)
	v, e := q.GetCockpitMeetingTemplateVersionByKey(ctx, db.GetCockpitMeetingTemplateVersionByKeyParams{WorkspaceID: p.WorkspaceID, CommandKey: key})
	if e != nil {
		return CockpitMeetingTemplateSaveResult{}, cockpitWorkflowError(e)
	}
	if v.CreatedBy != p.ActorID {
		return CockpitMeetingTemplateSaveResult{}, ErrCockpitWorkflowForbidden
	}
	return templateSaveResult(ctx, q, p, role, v, true)
}

func (s *IssueService) SaveCockpitMeetingTemplate(ctx context.Context, p CockpitMeetingTemplateQuery, in CockpitMeetingTemplateSaveInput) (CockpitMeetingTemplateSaveResult, error) {
	var out CockpitMeetingTemplateSaveResult
	if !p.Human {
		return out, ErrCockpitWorkflowForbidden
	}
	creating := !p.TemplateID.Valid
	if e := normalizeTemplateSave(&in, creating); e != nil {
		return out, e
	}
	key, _ := util.ParseUUID(in.CommandKey)
	hash := planningHash([]any{p.TemplateID, in})
	tx, e := s.TxStarter.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, e = q.LockWorkspaceForChatSessionCreate(ctx, p.WorkspaceID); e != nil {
		return out, cockpitWorkflowError(e)
	}
	_, e = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if e != nil {
		return out, cockpitWorkflowError(e)
	}
	m, e := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	if e != nil {
		return out, e
	}
	if e = q.LockCockpitTemplateCommand(ctx, db.LockCockpitTemplateCommandParams{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: util.UUIDToString(key)}); e != nil {
		return out, e
	}
	old, e := q.GetCockpitMeetingTemplateVersionByKey(ctx, db.GetCockpitMeetingTemplateVersionByKeyParams{WorkspaceID: p.WorkspaceID, CommandKey: key})
	if e == nil {
		if old.CreatedBy != p.ActorID || old.RequestHash != hash {
			return out, ErrCockpitWorkflowConflict
		}
		return templateSaveResult(ctx, q, p, m.Role, old, true)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	versionID := dbid.NewV7()
	number := int32(1)
	if creating {
		p.TemplateID = dbid.NewV7()
		_, e = q.CreateCockpitMeetingTemplate(ctx, db.CreateCockpitMeetingTemplateParams{ID: p.TemplateID, WorkspaceID: p.WorkspaceID, CurrentVersionID: versionID, Title: in.Title, Description: in.Description, IsActive: in.Active, CreatedBy: p.ActorID})
	} else {
		t, loadErr := q.LockCockpitMeetingTemplate(ctx, db.LockCockpitMeetingTemplateParams{WorkspaceID: p.WorkspaceID, ID: p.TemplateID})
		if loadErr != nil {
			return out, cockpitWorkflowError(loadErr)
		}
		if !templateManager(p.Human, p.ActorID, t.CreatedBy, m.Role) {
			return out, ErrCockpitWorkflowForbidden
		}
		if t.Revision != in.ExpectedRevision || t.Revision >= math.MaxInt32 {
			return out, ErrCockpitWorkflowConflict
		}
		number = int32(t.Revision + 1)
		_, e = q.UpdateCockpitMeetingTemplate(ctx, db.UpdateCockpitMeetingTemplateParams{WorkspaceID: p.WorkspaceID, ID: p.TemplateID, CurrentVersionID: versionID, Title: in.Title, Description: in.Description, IsActive: in.Active, Revision: in.ExpectedRevision})
	}
	if e != nil {
		return out, e
	}
	users, e := q.GetUsersByIDs(ctx, []pgtype.UUID{p.ActorID})
	if e != nil || len(users) != 1 {
		return out, fmt.Errorf("template author cannot be resolved: %w", e)
	}
	createdAt := time.Now().UTC()
	config, _ := json.Marshal(in.Config)
	d := CockpitMeetingTemplateVersionDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), Description: in.Description, Config: in.Config,
		CockpitMeetingTemplateVersionMetadata: CockpitMeetingTemplateVersionMetadata{ID: util.UUIDToString(versionID), TemplateID: util.UUIDToString(p.TemplateID), Number: number, Title: in.Title, Active: in.Active,
			SlotCount: int32(len(in.Config.Slots)), ConfigHash: planningHash(in.Config), CommandKey: util.UUIDToString(key), CreatedBy: util.UUIDToString(p.ActorID), CreatedByName: users[0].Name, CreatedAt: createdAt.Format(time.RFC3339Nano)}}
	receipt, _ := json.Marshal(d)
	v, e := q.CreateCockpitMeetingTemplateVersion(ctx, db.CreateCockpitMeetingTemplateVersionParams{ID: versionID, WorkspaceID: p.WorkspaceID, TemplateID: p.TemplateID, Number: number, Title: in.Title, Description: in.Description, IsActive: in.Active,
		Config: config, ConfigHash: d.ConfigHash, SlotCount: d.SlotCount, CommandKey: key, RequestHash: hash, Receipt: receipt, CreatedBy: p.ActorID, CreatedAt: pgtype.Timestamptz{Time: createdAt, Valid: true}})
	if e != nil {
		return out, e
	}
	out, e = templateSaveResult(ctx, q, p, m.Role, v, false)
	if e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e != nil {
		return CockpitMeetingTemplateSaveResult{}, e
	}
	s.planningChanged(p.WorkspaceID, p.ActorID, "meeting_templates", map[string]any{"id": out.TemplateID, "action": "updated"})
	return out, nil
}
