package service

import (
	"context"
	"encoding/json"
	"errors"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrCockpitExportLimit = errors.New("cockpit export exceeds 250000 task mappings; choose a project or module")

type CockpitPlanExportLink struct {
	NodeID          string `json:"node_id"`
	IssueIdentifier string `json:"issue_identifier"`
}
type CockpitPlanExport struct {
	CockpitSurfacePlan
	IssueLinks     []CockpitPlanExportLink `json:"issue_links"`
	IssueLinkTotal int64                   `json:"issue_link_total"`
	GeneratedAt    string                  `json:"generated_at"`
}

func (s *IssueService) GetCockpitPlanExport(ctx context.Context, p CockpitSurfaceQuery) (CockpitPlanExport, error) {
	var out CockpitPlanExport
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	out.CockpitSurfacePlan, err = readCockpitPlanSurface(ctx, q, header, p)
	if err != nil {
		return out, err
	}
	payload, err := q.GetCockpitPlanExportLinks(ctx, db.GetCockpitPlanExportLinksParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID})
	if err != nil {
		return out, err
	}
	var links struct {
		IssueLinks     []CockpitPlanExportLink `json:"issue_links"`
		IssueLinkTotal int64                   `json:"issue_link_total"`
		GeneratedAt    string                  `json:"generated_at"`
	}
	if err = json.Unmarshal(payload, &links); err != nil {
		return out, err
	}
	if links.IssueLinkTotal > 250000 {
		return CockpitPlanExport{}, ErrCockpitExportLimit
	}
	out.IssueLinks, out.IssueLinkTotal, out.GeneratedAt = links.IssueLinks, links.IssueLinkTotal, links.GeneratedAt
	return out, tx.Commit(ctx)
}
