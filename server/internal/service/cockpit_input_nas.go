package service

import (
	"context"
	"errors"

	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
)

func inputActorScope(p CockpitInputRead) string {
	return planningHash([]string{util.UUIDToString(p.WorkspaceID), "human", util.UUIDToString(p.CredentialOwnerID)})
}
func (s *IssueService) requireInputNAS(ctx context.Context, p CockpitInputRead) error {
	if p.ActorSource != "human" {
		return inputError("task_context_required", "NAS browsing and selection require an explicit human scope.")
	}
	if _, err := inputMembership(ctx, s.Queries, p); err != nil {
		return err
	}
	if s.CockpitInputConfigurationError != "" {
		return inputError("input_configuration_invalid", "The NAS input configuration needs administrator attention.")
	}
	if s.CockpitInputNAS == nil {
		return inputError("input_scope_not_configured", "NAS input access is not configured for this workspace.")
	}
	return nil
}
func (s *IssueService) ListCockpitInputSpaces(ctx context.Context, p CockpitInputRead) (CockpitInputSpacePage, error) {
	out := CockpitInputSpacePage{WorkspaceID: util.UUIDToString(p.WorkspaceID), Items: []CockpitInputSpace{}}
	if err := s.requireInputNAS(ctx, p); err != nil {
		var typed *CockpitInputError
		if errors.As(err, &typed) && typed.Code == "input_scope_not_configured" {
			return out, nil
		}
		return out, err
	}
	root, err := s.CockpitInputNAS.InputRoot(out.WorkspaceID)
	if err != nil {
		var typed *cockpitnas.Error
		if errors.As(err, &typed) && typed.Code == "input_scope_not_configured" {
			return out, nil
		}
		return out, inputConvertError(err)
	}
	out.Items = []CockpitInputSpace{{RootID: root.RootID, RootPath: root.Path, InputSubpaths: root.Subpaths, RootConfigHash: root.RootConfigHash, CanBrowse: true}}
	out.Total = 1
	return out, nil
}
func (s *IssueService) BrowseCockpitInputSpace(ctx context.Context, p CockpitInputRead, rootID string, in CockpitInputNASBrowseInput) (CockpitInputNASPage, error) {
	var out CockpitInputNASPage
	if err := s.requireInputNAS(ctx, p); err != nil {
		return out, err
	}
	if _, err := inputKey(rootID); err != nil {
		return out, err
	}
	if len(in.Query) > 512 {
		return out, inputError("invalid_input", "The directory search prefix is too long.")
	}
	page, err := s.CockpitInputNAS.BrowseInput(ctx, cockpitnas.InputBrowseRequest{WorkspaceID: util.UUIDToString(p.WorkspaceID), ActorScope: inputActorScope(p), RootID: rootID, RelativeDirectory: in.RelativeDirectory, Query: in.Query, Cursor: in.Cursor, PageSize: in.PageSize})
	if err != nil {
		return out, inputConvertError(err)
	}
	out = CockpitInputNASPage{WorkspaceID: page.WorkspaceID, RootID: page.RootID, RelativeDirectory: page.RelativeDirectory, Query: page.Query, RootConfigHash: page.RootConfigHash, ObservationToken: page.ObservationToken, PageSize: page.PageSize, Items: []CockpitInputNASEntry{}, Total: page.Total, HasMore: page.HasMore, NextCursor: page.NextCursor}
	for _, e := range page.Items {
		selectFile := e.CanSelect
		reason := e.UnavailableReason
		if e.SizeBytes != nil && *e.SizeBytes > CockpitInputMaxFileBytes {
			selectFile = false
			reason = "input_too_large"
		}
		out.Items = append(out.Items, CockpitInputNASEntry{Name: e.Name, RelativePath: e.RelativePath, Kind: e.Kind, SizeBytes: e.SizeBytes, ModifiedAt: e.ModifiedAt, ObservationToken: e.ObservationToken, CanSelect: selectFile, CanOpenDirectory: e.CanOpenDirectory, UnavailableReason: reason})
	}
	return out, nil
}
