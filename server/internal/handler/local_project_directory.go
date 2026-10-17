package handler

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/localpaths"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var localProjectBindingMu sync.Mutex

func (h *Handler) unusedLocalProjectPath(ctx context.Context, path, exclude string) error {
	rows, err := h.DB.Query(ctx, `SELECT id::text, collab_path FROM project WHERE collab_path IS NOT NULL AND id::text <> $1`, exclude)
	if err != nil {
		return err
	}
	defer rows.Close()
	actual, err := localpaths.CanonicalPath(path)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, other string
		if err := rows.Scan(&id, &other); err != nil {
			return err
		}
		canonical, err := localpaths.CanonicalPath(other)
		if err == nil && strings.EqualFold(actual, canonical) {
			return errors.New("directory is already bound to another project")
		}
	}
	return rows.Err()
}

func allowedLocalProjectPath(path string) error {
	if err := localpaths.InternalDirectory(path); err != nil {
		return err
	}
	instance, _ := localpaths.CanonicalPath(os.Getenv("MULTICA_INSTANCE_HOME"))
	actual, err := localpaths.CanonicalPath(path)
	if err != nil {
		return err
	}
	instance = strings.ToLower(instance)
	actual = strings.ToLower(actual)
	if instance != "." && (actual == instance || strings.HasPrefix(actual, instance+string(os.PathSeparator)) || strings.HasPrefix(instance, actual+string(os.PathSeparator))) {
		return errors.New("project files must be outside private application state")
	}
	return nil
}
func localProjectDirectory(title string, selected pgtype.Text) (path string, created bool, err error) {
	if selected.Valid && selected.String != "" {
		path = selected.String
	} else {
		root := os.Getenv("MULTICA_PROJECTS_HOME")
		if root == "" {
			return "", false, errors.New("local projects root is not configured")
		}
		path = filepath.Join(root, localpaths.Folder(title, localSecret()[:8]))
	}
	if err = allowedLocalProjectPath(path); err != nil {
		return
	}
	err = os.Mkdir(path, 0700)
	if err == nil {
		return path, true, nil
	}
	if !os.IsExist(err) {
		return
	}
	info, e := os.Lstat(path)
	if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", false, errors.New("project path must be an ordinary local directory")
	}
	probe, e := os.CreateTemp(path, ".helixhelm-access-")
	if e != nil {
		return "", false, errors.New("project directory is not writable")
	}
	name := probe.Name()
	probe.Close()
	os.Remove(name)
	return path, false, nil
}
