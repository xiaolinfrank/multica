package localpaths

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func CanonicalPath(path string) (string, error) {
	path = filepath.Clean(path)
	parent := path
	for {
		if _, e := os.Stat(parent); e == nil {
			break
		}
		next := filepath.Dir(parent)
		if next == parent {
			return "", errors.New("directory has no accessible parent")
		}
		parent = next
	}
	actual, e := filepath.EvalSymlinks(parent)
	if e != nil {
		return "", e
	}
	suffix, e := filepath.Rel(parent, path)
	if e != nil {
		return "", e
	}
	return filepath.Join(actual, suffix), nil
}

// InternalDirectory checks the actual containing volume, including symlink ancestors.
func InternalDirectory(path string) error {
	if runtime.GOOS != "darwin" || !filepath.IsAbs(path) {
		return errors.New("this local deployment requires an internal macOS disk")
	}
	if path == "/Volumes" || strings.HasPrefix(path, "/Volumes/") || strings.Contains(path, "/Mobile Documents/") || strings.Contains(path, "/CloudStorage/") {
		return errors.New("choose an ordinary internal disk directory")
	}
	parent := filepath.Clean(path)
	for {
		if _, e := os.Stat(parent); e == nil {
			break
		}
		next := filepath.Dir(parent)
		if next == parent {
			return errors.New("directory has no accessible parent")
		}
		parent = next
	}
	actual, e := filepath.EvalSymlinks(parent)
	if e != nil {
		return e
	}
	if strings.HasPrefix(actual, "/Volumes/") || strings.Contains(actual, "/Mobile Documents/") || strings.Contains(actual, "/CloudStorage/") {
		return errors.New("choose an ordinary internal disk directory")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, e := exec.CommandContext(ctx, "/bin/df", "-P", actual).Output()
	if e != nil {
		return errors.New("cannot inspect directory volume")
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) == 0 || !strings.HasPrefix(fields[0], "/dev/disk") {
		return errors.New("directory is not on a local disk")
	}
	out, e = exec.CommandContext(ctx, "/usr/sbin/diskutil", "info", "-plist", fields[0]).Output()
	if e != nil {
		return errors.New("cannot inspect internal disk identity")
	}
	cmd := exec.CommandContext(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", "-")
	cmd.Stdin = strings.NewReader(string(out))
	out, e = cmd.Output()
	if e != nil {
		return errors.New("cannot read disk identity")
	}
	var v struct {
		Internal       bool
		DeviceLocation string
	}
	if json.Unmarshal(out, &v) != nil || (!v.Internal && v.DeviceLocation != "Internal") {
		return errors.New("directory must be on the internal disk")
	}
	return nil
}
