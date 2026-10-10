//go:build darwin || linux

package cockpitnas

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const maxCompletionBytes = 8192

type completionReceipt struct {
	SchemaVersion int    `json:"schema_version"`
	WriteMode     string `json:"write_mode"`
	WorkspaceID   string `json:"workspace_id"`
	MeetingID     string `json:"meeting_id"`
	RootID        string `json:"root_id"`
	ExportID      string `json:"export_id"`
	VersionID     string `json:"version_id"`
	AttemptID     string `json:"attempt_id"`
	ContentFile   string `json:"content_file"`
	ContentHash   string `json:"content_hash"`
	SizeBytes     int64  `json:"size_bytes"`
}

func expectedCompletion(request Request) completionReceipt {
	return completionReceipt{SchemaVersion: 1, WriteMode: ModeCreateOnly, WorkspaceID: request.WorkspaceID,
		MeetingID: request.MeetingID, RootID: request.Destination.RootID, ExportID: request.OperationID,
		VersionID: request.VersionID, AttemptID: request.AttemptID, ContentFile: filepath.Base(request.Destination.TargetPath),
		ContentHash: request.ContentHash, SizeBytes: int64(len(request.Content))}
}

type createOnlyDirectories struct {
	root               Root
	anchor             *os.Root
	files              []*os.File
	rootDir, meeting   *os.File
	published, mode    *os.File
	operation, attempt *os.File
	relativeMeeting    string
	newAttempt         bool
}

func (d *createOnlyDirectories) close() {
	for i := len(d.files) - 1; i >= 0; i-- {
		_ = d.files[i].Close()
	}
	if d.anchor != nil {
		_ = d.anchor.Close()
	}
}

func incompleteAttempt() error {
	return fail("attempt_incomplete", "This retained attempt has no fully verified completion record; a new attempt is required.", true)
}

func (f *Files) openCreateOnly(request Request, create bool) (_ *createOnlyDirectories, err error) {
	root, err := f.validate(request)
	if err != nil {
		return nil, err
	}
	if root.WriteMode != ModeCreateOnly {
		return nil, fail("invalid_destination", "Attempt verification requires create-only storage mode.", false)
	}
	d := &createOnlyDirectories{root: root}
	defer func() {
		if err != nil {
			d.close()
		}
	}()
	d.anchor, err = os.OpenRoot(root.Path)
	if err != nil {
		return nil, classifyIO(err, "The configured NAS root is unavailable.")
	}
	d.rootDir, err = d.anchor.Open(".")
	if err != nil {
		return nil, classifyIO(err, "The configured NAS root is unavailable.")
	}
	d.files = append(d.files, d.rootDir)
	if !root.AllowLocal {
		mounted, mountErr := isNetworkMount(d.rootDir)
		if mountErr != nil || !mounted {
			return nil, fail("mount_unavailable", "The configured root is not on an available network filesystem.", true)
		}
	}
	marker, err := readRegular(d.rootDir, MarkerName, 128)
	if err != nil {
		return nil, classifyIO(err, "The NAS identity marker is unavailable.")
	}
	if strings.TrimSpace(string(marker)) != root.RootID {
		return nil, fail("identity_mismatch", "The NAS root identity does not match its configuration.", false)
	}
	d.relativeMeeting, _ = filepath.Rel(root.Path, request.Destination.Directory)
	d.meeting = d.rootDir
	if d.relativeMeeting != "." {
		for _, component := range strings.Split(d.relativeMeeting, string(filepath.Separator)) {
			next, openErr := openDirectory(d.meeting, component)
			if openErr != nil {
				return nil, classifyIO(openErr, "The meeting directory is unavailable; provision or reconnect it before retrying.")
			}
			d.files = append(d.files, next)
			d.meeting = next
		}
	}
	parent := d.meeting
	for i, name := range []string{PublishedDirectory, CreateOnlyDirectory, request.OperationID, request.AttemptID} {
		if create {
			mkdirErr := unix.Mkdirat(int(parent.Fd()), name, 0o755)
			if mkdirErr != nil && !errors.Is(mkdirErr, unix.EEXIST) {
				return nil, classifyIO(mkdirErr, "The create-only export directory could not be created.")
			}
			if i == 3 {
				d.newAttempt = mkdirErr == nil
			}
		}
		next, openErr := openDirectory(parent, name)
		if openErr != nil {
			if !create && errors.Is(openErr, unix.ENOENT) {
				return nil, incompleteAttempt()
			}
			return nil, classifyIO(openErr, "The recorded export attempt directory is unavailable.")
		}
		d.files = append(d.files, next)
		switch i {
		case 0:
			d.published = next
		case 1:
			d.mode = next
		case 2:
			d.operation = next
		case 3:
			d.attempt = next
		}
		parent = next
	}
	return d, nil
}

func (d *createOnlyDirectories) verifyNames(request Request) error {
	if err := verifyExportDirectories(d.root, d.relativeMeeting, d.rootDir, d.meeting, d.published); err != nil {
		return err
	}
	parent := d.published
	var reopened []*os.File
	defer func() {
		for _, file := range reopened {
			_ = file.Close()
		}
	}()
	for _, item := range []struct {
		name string
		held *os.File
	}{
		{CreateOnlyDirectory, d.mode}, {request.OperationID, d.operation}, {request.AttemptID, d.attempt},
	} {
		current, err := openDirectory(parent, item.name)
		if err != nil {
			return classifyReopen(err)
		}
		reopened = append(reopened, current)
		if err := sameDirectory(item.held, current); err != nil {
			return err
		}
		parent = current
	}
	return nil
}

func verifiedCompletion(d *createOnlyDirectories, request Request) (Result, error) {
	data, err := readRegular(d.attempt, CompletionName, maxCompletionBytes)
	if errors.Is(err, unix.ENOENT) {
		return Result{}, incompleteAttempt()
	}
	if err != nil {
		return Result{}, classifyIO(err, "The completion record could not be read.")
	}
	var receipt completionReceipt
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Result{}, incompleteAttempt()
		}
		return Result{}, fail("receipt_conflict", "The completion record is invalid and was retained for inspection.", false)
	}
	if decoder.Decode(new(any)) != io.EOF || receipt != expectedCompletion(request) {
		return Result{}, fail("receipt_conflict", "The completion record does not identify the exact approved content and attempt.", false)
	}
	body, err := readRegular(d.attempt, receipt.ContentFile, MaxContentBytes)
	if errors.Is(err, unix.ENOENT) {
		return Result{}, incompleteAttempt()
	}
	if err != nil {
		return Result{}, classifyIO(err, "The recorded minutes file could not be read.")
	}
	if string(body) != request.Content || fmt.Sprintf("%x", sha256.Sum256(body)) != request.ContentHash {
		return Result{}, fail("file_conflict", "The completed attempt's content differs from its fixed version; it was not overwritten.", false)
	}
	target, completion, err := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
	if err != nil {
		return Result{}, err
	}
	return Result{Path: target, ReceiptPath: completion, ReceiptHash: fmt.Sprintf("%x", sha256.Sum256(data)),
		AttemptID: request.AttemptID, ContentHash: request.ContentHash, Size: int64(len(body))}, nil
}

func (f *Files) finishCreateOnly(ctx context.Context, d *createOnlyDirectories, request Request) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if err := d.verifyNames(request); err != nil {
		return Result{}, err
	}
	result, err := verifiedCompletion(d, request)
	if err != nil {
		return Result{}, err
	}
	// Another verifier can observe the complete JSON before its creator's fsync
	// returns. Synchronize both regular files as well; SMB requires a handle
	// opened for writing to flush. No create, truncation, append or write occurs.
	for _, name := range []string{filepath.Base(result.Path), CompletionName} {
		if err := syncExistingRegular(d.attempt, name); err != nil {
			return Result{}, err
		}
	}
	// This also reconciles a receipt whose earlier writer lost a sync or DB ACK.
	// It does not claim a network filesystem's accepted fsync proves power-loss durability.
	for _, directory := range []*os.File{d.attempt, d.operation, d.mode, d.published, d.meeting} {
		if err := f.syncExportDirectory(directory); err != nil {
			return Result{}, err
		}
	}
	if f.beforeAck != nil {
		f.beforeAck()
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if err := d.verifyNames(request); err != nil {
		return Result{}, err
	}
	again, err := verifiedCompletion(d, request)
	if err != nil {
		return Result{}, err
	}
	if result != again {
		return Result{}, fail("receipt_conflict", "The completion evidence changed during verification.", false)
	}
	return result, nil
}

func syncExistingRegular(parent *os.File, name string) error {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_WRONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return classifyIO(err, "The completion evidence could not be synchronized.")
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return classifyIO(err, "The completion evidence could not be inspected.")
	}
	if !info.Mode().IsRegular() {
		return fail("file_conflict", "The completion evidence is not a regular file.", false)
	}
	checkIdentity := func() error {
		var held, named unix.Stat_t
		if err := unix.Fstat(fd, &held); err != nil {
			return classifyReopen(err)
		}
		if err := unix.Fstatat(int(parent.Fd()), name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return classifyReopen(err)
		}
		if held.Dev != named.Dev || held.Ino != named.Ino || named.Mode&unix.S_IFMT != unix.S_IFREG {
			return pathChanged()
		}
		return nil
	}
	if err := checkIdentity(); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return classifyIO(err, "The completed file could not be synchronized; verification will be retried.")
	}
	return checkIdentity()
}

// VerifyAttempt only reads and synchronizes an already recorded attempt. It
// never creates, writes content, appends, renames or removes a file, and never
// scans arbitrary NAS directories.
func (f *Files) VerifyAttempt(ctx context.Context, request Request) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	d, err := f.openCreateOnly(request, false)
	if err != nil {
		return Result{}, err
	}
	defer d.close()
	return f.finishCreateOnly(ctx, d, request)
}

func writeNewFile(parent *os.File, name string, content []byte, hook func(*os.File, []byte) error) error {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o644)
	if errors.Is(err, unix.EEXIST) {
		return fail("file_conflict", "An entry already exists in this attempt; it was not overwritten.", false)
	}
	if err != nil {
		return classifyIO(err, "The create-only file could not be created.")
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	if hook != nil {
		err = hook(file, content)
	} else {
		_, err = io.Copy(file, bytes.NewReader(content))
	}
	if err != nil {
		return classifyIO(err, "The create-only write did not complete; its unverified files were retained.")
	}
	if err := file.Sync(); err != nil {
		return classifyIO(err, "The create-only file could not be synchronized.")
	}
	if err := file.Close(); err != nil {
		return classifyIO(err, "The create-only file could not be closed.")
	}
	return nil
}

// Files may be visible while being written. Only verified content plus a fully
// parsed completion record can become the platform's confirmed NAS copy.
// Failed attempts remain intact: this mode has no rename or delete operation.
func (f *Files) writeCreateOnly(ctx context.Context, request Request) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	d, err := f.openCreateOnly(request, true)
	if err != nil {
		return Result{}, err
	}
	defer d.close()
	if !d.newAttempt {
		return f.finishCreateOnly(ctx, d, request)
	}
	if err := d.verifyNames(request); err != nil {
		return Result{}, err
	}
	name := filepath.Base(request.Destination.TargetPath)
	if err := writeNewFile(d.attempt, name, []byte(request.Content), f.writeCreateOnlyFile); err != nil {
		return Result{}, err
	}
	data, err := readRegular(d.attempt, name, MaxContentBytes)
	if err != nil {
		return Result{}, classifyIO(err, "The newly written minutes could not be verified.")
	}
	if string(data) != request.Content || fmt.Sprintf("%x", sha256.Sum256(data)) != request.ContentHash {
		return Result{}, fail("file_conflict", "The new attempt did not preserve the fixed minutes content.", false)
	}
	if f.beforeCommit != nil {
		f.beforeCommit()
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if err := d.verifyNames(request); err != nil {
		return Result{}, err
	}
	completion, err := json.Marshal(expectedCompletion(request))
	if err != nil {
		return Result{}, err
	}
	if err := writeNewFile(d.attempt, CompletionName, completion, f.writeCreateOnlyReceipt); err != nil {
		return Result{}, err
	}
	return f.finishCreateOnly(ctx, d, request)
}
