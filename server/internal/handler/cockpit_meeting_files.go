package handler

import (
	"context"
	"errors"

	"github.com/multica-ai/multica/server/internal/collabfs"
)

// The meeting archive and the plan's collaboration folders need the same
// guarantees: a pinned root, one component opened at a time, no symlink
// followed, no write outside the root. Those live in collabfs; this file keeps
// the meeting-specific names as thin adapters so the meeting code reads as it
// always did.

var errMeetingDirectoryChanged = collabfs.ErrDirectoryChanged

type meetingArchiveRoot struct{ *collabfs.Root }

type meetingArchiveDirectory struct{ *collabfs.Dir }

// openMeetingArchive pins the configured root for the duration of one call.
// Ancestor platform aliases may resolve to a real root; the final configured
// root itself must not be a link.
func openMeetingArchive(root string) (*meetingArchiveRoot, error) {
	pinned, err := collabfs.OpenRoot(root)
	if err != nil {
		if errors.Is(err, collabfs.ErrRootUnavailable) {
			return nil, errors.New("meeting folder root is unavailable: " + err.Error())
		}
		return nil, err
	}
	return &meetingArchiveRoot{pinned}, nil
}

func (a *meetingArchiveRoot) close() { a.Close() }

func (a *meetingArchiveRoot) verify() error { return a.Verify() }

func (a *meetingArchiveRoot) directory(path string, create bool) (*meetingArchiveDirectory, error) {
	dir, err := a.Directory(path, create)
	if err != nil {
		return nil, err
	}
	return &meetingArchiveDirectory{dir}, nil
}

func (d *meetingArchiveDirectory) child(name string, create bool) (*meetingArchiveDirectory, error) {
	child, err := d.Child(name, create)
	if err != nil {
		return nil, err
	}
	return &meetingArchiveDirectory{child}, nil
}

func (d *meetingArchiveDirectory) verify() error { return d.Verify() }

func (d *meetingArchiveDirectory) entries(ctx context.Context, limit int) ([]string, bool, error) {
	return d.Entries(ctx, limit)
}

func (d *meetingArchiveDirectory) visibleCount(ctx context.Context) (int, error) {
	return d.VisibleCount(ctx)
}
