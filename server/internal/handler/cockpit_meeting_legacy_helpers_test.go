package handler

// Existing filesystem boundary regressions exercise these test-only helpers.
// Production directory writes use the durable preparation service exclusively.
import (
	"errors"
	"fmt"
	"strings"
)

// ensureMeetingBase creates the folders between root and dir that are not
// there yet, one level at a time.
//
// Root itself is never created. Everything below it is fair game: an archive
// sub-item that nobody has made a folder for is an ordinary state of a share
// that IS mounted, and refusing to file a meeting over it would send someone
// to Finder to create one empty directory.
func ensureMeetingBase(root, dir string) error {
	archive, err := openMeetingArchive(root)
	if err != nil {
		return err
	}
	defer archive.close()
	_, err = archive.directory(dir, true)
	return err
}

// createMeetingDir creates one folder under base and returns its path.
//
// The name is sanitised to a single component and the result is re-checked
// against base after cleaning, so a title full of separators still cannot
// address anything outside the folder the board configured. Creating a folder
// that already exists is success: provisioning is re-runnable.
func createMeetingDir(base, name string) (string, error) {
	component := sanitizeMeetingFolderName(name)
	if component == "" {
		return "", errors.New("meeting folder name is empty")
	}
	archive, err := openMeetingArchive(base)
	if err != nil {
		return "", err
	}
	defer archive.close()
	dir, err := archive.directory(base, false)
	if err != nil {
		return "", err
	}
	child, err := dir.child(component, true)
	if err != nil {
		return "", err
	}
	return child.path, child.verify()
}

// meetingSubdirs are the drawers every meeting folder is given. Three fixed
// names, so material lands in the same place whoever files it and whoever
// goes looking for it a year later knows where to look.
var meetingSubdirs = []string{"会议纪要与录音转写", "会议材料", "照片"}

// createMeetingSubdirs fills a meeting folder with its drawers.
//
// Re-runnable like the folder itself: drawers that are already there are
// left alone, and one that was renamed or removed by hand comes back. The
// error names what could not be created rather than stopping at the first
// failure — a share that half-answers should report both.
func createMeetingSubdirs(dir string) error {
	archive, err := openMeetingArchive(dir)
	if err != nil {
		return err
	}
	defer archive.close()
	base, err := archive.directory(dir, false)
	if err != nil {
		return err
	}
	return base.createSubdirs()
}

func (d *meetingArchiveDirectory) createSubdirs() error {
	var failed []string
	for _, name := range meetingSubdirs {
		child, err := d.child(name, true)
		if err != nil {
			failed = append(failed, name)
			continue
		}
		_ = child.file.Close()
	}
	if err := d.verify(); err != nil {
		return err
	}
	if len(failed) > 0 {
		return fmt.Errorf("meeting subfolders not created: %s", strings.Join(failed, ", "))
	}
	return nil
}
