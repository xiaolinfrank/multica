package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitNodeCodePreview struct {
	WorkspaceID string  `json:"workspace_id"`
	ParentID    *string `json:"parent_id"`
	Code        string  `json:"code"`
}

func (s *IssueService) GetCockpitNodeCodePreview(ctx context.Context, p CockpitSurfaceQuery, parent pgtype.UUID) (CockpitNodeCodePreview, error) {
	var out CockpitNodeCodePreview
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	code, err := ReadCockpitNextNodeCode(ctx, q, p.WorkspaceID, parent)
	if err != nil {
		return out, err
	}
	out = CockpitNodeCodePreview{WorkspaceID: header.WorkspaceID, ParentID: planningUUID(parent), Code: code}
	return out, tx.Commit(ctx)
}

// numericDottedCodeRe marks stored codes built of two or more two-digit
// dot-separated segments ("01.03", "04.03.10"): the board's published
// address family, and the shape the gantt's positional display codes quote.
// A bare module code ("01") stays out — minting "01.01" under it would
// produce a direction-shaped code the frontend files as structure.
var numericDottedCodeRe = regexp.MustCompile(`^\d{2}\.\d{2}(\.\d{2})*$`)

// storedZeroSegmentCodeRe mirrors the display layer's governance carve-out:
// a first child whose stored code ends in ".00" keeps that published code
// and the siblings after it number from 01, so the row occupies no number
// in the parent's sequence.
var storedZeroSegmentCodeRe = regexp.MustCompile(`^\d{2}(\.\d{2})*\.00$`)

// nextCockpitChildCode picks the first number past everything the board has
// ever handed out under this parent. The separator mirrors the parent's own
// style: dotted parents ("01.03") continue dotted ("01.03.06"), anything else
// ("AI-03-02", "01") keeps the legacy PARENT-NN shape. The count starts from
// the live child rows as well as the ledger, because a deleted row's number
// stays spent while a child wearing an unrelated legacy code ("L3-01-33")
// still occupies a visible position the answer must step past — otherwise
// the preview reads as a duplicate of a sibling the reader can see. Codes
// with a non-numeric tail (hand-edited rows) keep their ledger entry but do
// not join the count: 02.02.1 and 02.02.01 are distinct codes, both stay
// spent, and neither is re-issued.
func nextCockpitChildCode(parentCode string, used []string, childCount int) string {
	sep := "-"
	if numericDottedCodeRe.MatchString(parentCode) {
		sep = "."
	}
	prefix := parentCode + sep
	max := childCount
	for _, code := range used {
		if !strings.HasPrefix(code, prefix) {
			continue
		}
		n, err := strconv.Atoi(code[len(prefix):])
		if err != nil || n <= 0 {
			continue
		}
		if n > max {
			max = n
		}
	}
	return prefix + fmt.Sprintf("%02d", max+1)
}

// liveChildFloor counts the rows currently under parentID for next-code
// purposes. A first child wearing a ".00" governance code sits outside the
// numbered sequence the gantt shows, so it does not push the next number.
func liveChildFloor(nodes []db.CockpitNode, parentID pgtype.UUID) int {
	count := 0
	var first *db.CockpitNode
	for i := range nodes {
		n := &nodes[i]
		if n.ParentID != parentID {
			continue
		}
		count++
		if first == nil || n.Position < first.Position {
			first = n
		}
	}
	if first != nil && storedZeroSegmentCodeRe.MatchString(first.Code) {
		count--
	}
	return count
}

// Writers hold the workspace board lock; readers use it only as a preview.
// Codes are handed out once (migration 948), so the answer steps past every
// number the board has ever used — deleted rows included. The live child
// count keeps the answer ahead of rows whose codes name no number under this
// parent (e.g. legacy L3-coded tasks). A parentless read addresses the
// board's own L1 family.
func ReadCockpitNextNodeCode(ctx context.Context, q *db.Queries, workspace, parent pgtype.UUID) (string, error) {
	board, err := q.GetCockpitByWorkspace(ctx, workspace)
	if errors.Is(err, pgx.ErrNoRows) {
		// A preview never initializes the board; an absent board has spent
		// nothing, so the L1 family starts at 01.
		if parent.Valid {
			return "", fmt.Errorf("%w: parent node not found", ErrCockpitWorkflowInput)
		}
		return nextCockpitChildCode("L1", nil, 0), nil
	}
	if err != nil {
		return "", err
	}
	parentCode := "L1"
	if parent.Valid {
		node, e := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspace, ID: parent})
		if errors.Is(e, pgx.ErrNoRows) {
			return "", fmt.Errorf("%w: parent node not found", ErrCockpitWorkflowInput)
		}
		if e != nil {
			return "", e
		}
		if node.CockpitID != board.ID {
			return "", fmt.Errorf("%w: parent node belongs to another cockpit", ErrCockpitWorkflowInput)
		}
		parentCode = node.Code
	}
	// The ledger is written on create; a row that somehow predates it (or a
	// delete racing this read) must still not let its number come back, so
	// the live nodes join the count too.
	used, err := q.ListCockpitUsedCodes(ctx, board.ID)
	if err != nil {
		return "", err
	}
	nodes, err := q.ListCockpitNodes(ctx, board.ID)
	if err != nil {
		return "", err
	}
	childCount := liveChildFloor(nodes, parent)
	for _, n := range nodes {
		used = append(used, n.Code)
	}
	return nextCockpitChildCode(parentCode, used, childCount), nil
}
