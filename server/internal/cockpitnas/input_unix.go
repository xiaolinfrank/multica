//go:build darwin || linux

package cockpitnas

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

func inputBrowseInvalid() error {
	return fail("invalid_input", "The input browser requires an exact actor scope, directory and bounded page.", false)
}
func inputCursorChanged() error {
	return fail("cursor_changed", "The directory or browsing scope changed. Return to the first page to inspect it again.", false)
}
func (f *Files) BrowseInput(ctx context.Context, r InputBrowseRequest) (InputBrowsePage, error) {
	var empty InputBrowsePage
	if r.PageSize == 0 {
		r.PageSize = 25
	}
	if r.ActorScope == "" || len(r.ActorScope) > 512 || r.PageSize < 1 || r.PageSize > 100 || len(r.Query) > 512 || !utf8.ValidString(r.Query) || len(r.Cursor) > 4096 {
		return empty, inputBrowseInvalid()
	}
	if err := ctx.Err(); err != nil {
		return empty, inputIO(err)
	}
	root, config, err := f.inputRoot(r.WorkspaceID, r.RootID, r.RelativeDirectory)
	if err != nil {
		return empty, err
	}
	state, err := f.inputStateReady()
	if err != nil {
		return empty, err
	}
	scope := inputBrowseScope(r, root, config)
	now := time.Now()
	state.reap(now)
	id := ""
	var session *inputSession
	if r.Cursor == "" {
		nonce := make([]byte, 24)
		if _, err = rand.Read(nonce); err != nil {
			return empty, err
		}
		id = hex.EncodeToString(nonce)
		session = &inputSession{request: r, scope: scope, configHash: config, expires: now.Add(inputSessionTTL), busy: true}
		state.mu.Lock()
		if len(state.sessions) >= inputSessionLimit {
			state.mu.Unlock()
			return empty, fail("input_io_busy", "The bounded input browser is busy. Retry after an existing session expires.", true)
		}
		state.sessions[id] = session
		state.mu.Unlock()
		if err = f.openInputEnumeration(ctx, root, session); err != nil {
			state.discard(id, session)
			return empty, err
		}
	} else {
		token, decodeErr := state.decode(r.Cursor, "cursor", scope, now)
		if decodeErr != nil {
			return empty, fail("cursor_expired", "This directory cursor is no longer available. Return to the first page.", false)
		}
		id = token.Session
		state.mu.Lock()
		session = state.sessions[id]
		if session == nil || session.scope != scope || !now.Before(session.expires) {
			state.mu.Unlock()
			return empty, fail("cursor_expired", "This directory cursor expired. Return to the first page.", false)
		}
		if session.busy {
			state.mu.Unlock()
			return empty, fail("input_io_busy", "This directory page is already being read.", true)
		}
		if token.Sequence != session.sequence && !(session.lastPage != nil && session.lastCursor == r.Cursor) {
			state.mu.Unlock()
			return empty, inputCursorChanged()
		}
		session.busy = true
		state.mu.Unlock()
	}
	success := false
	defer func() {
		if !success {
			state.discard(id, session)
		}
	}()
	if err = session.verify(ctx); err != nil {
		return empty, inputCursorChanged()
	}
	if r.Cursor != "" && session.lastPage != nil && session.lastCursor == r.Cursor {
		page := *session.lastPage
		page.Items = append([]InputBrowseEntry{}, page.Items...)
		state.mu.Lock()
		session.busy = false
		state.mu.Unlock()
		success = true
		return page, nil
	}
	page := InputBrowsePage{WorkspaceID: r.WorkspaceID, RootID: r.RootID, RelativeDirectory: r.RelativeDirectory, Query: r.Query, RootConfigHash: config, PageSize: r.PageSize, Items: []InputBrowseEntry{}}
	for checked := 0; checked < inputPageScanBudget && len(page.Items) < int(r.PageSize); checked++ {
		if err = ctx.Err(); err != nil {
			return empty, inputIO(err)
		}
		name, readErr := session.nextName()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return empty, inputIO(readErr)
		}
		if !strings.HasPrefix(name, r.Query) {
			continue
		}
		entry, entryErr := f.inputEntry(state, session, root, name, now)
		if entryErr != nil {
			return empty, entryErr
		}
		page.Items = append(page.Items, entry)
	}
	name, readErr := session.nextName()
	if readErr != nil && readErr != io.EOF {
		return empty, inputIO(readErr)
	}
	if readErr == nil {
		session.pendingName = name
		page.HasMore = true
	}
	if err = session.verify(ctx); err != nil {
		return empty, inputCursorChanged()
	}
	dir, err := inputStat(session.directory)
	if err != nil {
		return empty, inputIO(err)
	}
	page.ObservationToken, err = state.seal(inputToken{Kind: "directory", Scope: inputActorScope(r.WorkspaceID, r.ActorScope), Expires: now.Add(inputObservationTTL).Unix(), Observation: &InputObservation{WorkspaceID: r.WorkspaceID, RootID: r.RootID, RootPath: root.Path, RootConfigHash: config, RootIdentity: session.rootIdentity, RelativePath: r.RelativeDirectory, FileIdentity: dir.identity(), SizeBytes: dir.Size, MtimeNS: dir.ModifiedNS}})
	if err != nil {
		return empty, err
	}
	session.sequence++
	if page.HasMore {
		next, sealErr := state.seal(inputToken{Kind: "cursor", Scope: scope, Session: id, Sequence: session.sequence, Expires: session.expires.Unix()})
		if sealErr != nil {
			return empty, sealErr
		}
		page.NextCursor = &next
	}
	if !page.HasMore && r.Cursor == "" {
		state.discard(id, session)
		success = true
		return page, nil
	}
	copyPage := page
	copyPage.Items = append([]InputBrowseEntry{}, page.Items...)
	state.mu.Lock()
	session.lastCursor = r.Cursor
	session.lastPage = &copyPage
	session.busy = false
	state.mu.Unlock()
	success = true
	return page, nil
}
func (s *inputSession) nextName() (string, error) {
	if s.pendingName != "" {
		name := s.pendingName
		s.pendingName = ""
		return name, nil
	}
	names, err := s.directory.Readdirnames(1)
	if len(names) > 0 {
		return names[0], nil
	}
	if err == nil {
		err = io.EOF
	}
	return "", err
}
func (f *Files) openInputEnumeration(ctx context.Context, root Root, s *inputSession) error {
	if err := ctx.Err(); err != nil {
		return inputIO(err)
	}
	h, err := openPreparationRoot(root)
	if err != nil {
		return inputIO(err)
	}
	directory, closePath, err := openInputPath(ctx, h.root, s.request.RelativeDirectory)
	if err != nil {
		h.close()
		return inputIO(err)
	}
	s.directory = directory
	s.close = func() { closePath(); h.close() }
	original, err := inputStat(directory)
	if err != nil {
		return inputIO(err)
	}
	s.rootIdentity, err = directoryIdentity(h.root)
	if err != nil {
		return inputIO(err)
	}
	s.verify = func(ctx context.Context) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		_, config, err := f.inputRoot(s.request.WorkspaceID, s.request.RootID, s.request.RelativeDirectory)
		if err != nil || config != s.configHash {
			return inputCursorChanged()
		}
		if err = verifyInputDirectory(ctx, h, s.request.RelativeDirectory, directory); err != nil {
			return err
		}
		now, err := inputStat(directory)
		if err != nil {
			return err
		}
		if now != original {
			return inputCursorChanged()
		}
		return nil
	}
	return s.verify(ctx)
}
func (f *Files) inputEntry(state *inputState, s *inputSession, root Root, name string, now time.Time) (InputBrowseEntry, error) {
	relative := filepath.Join(s.request.RelativeDirectory, name)
	out := InputBrowseEntry{Name: strings.ToValidUTF8(name, "�"), RelativePath: strings.ToValidUTF8(relative, "�"), Kind: "unsupported"}
	if !validInputRelative(relative) || inputProtectedPath(relative, true) {
		out.UnavailableReason = "reserved_path"
		return out, nil
	}
	stat, err := inputStatAt(s.directory, name)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return out, inputCursorChanged()
		}
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			out.UnavailableReason = "permission_denied"
			return out, nil
		}
		return out, inputIO(err)
	}
	modified := time.Unix(0, stat.ModifiedNS).UTC().Format(time.RFC3339Nano)
	out.ModifiedAt = &modified
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		out.Kind = "directory"
		out.CanOpenDirectory = true
	case unix.S_IFREG:
		out.Kind = "file"
		size := stat.Size
		out.SizeBytes = &size
		if size < 0 || size > inputFileByteLimit {
			out.UnavailableReason = "file_too_large"
			return out, nil
		}
		observation := InputObservation{WorkspaceID: s.request.WorkspaceID, RootID: root.RootID, RootPath: root.Path, RootConfigHash: s.configHash, RootIdentity: s.rootIdentity, RelativePath: relative, FileIdentity: stat.identity(), SizeBytes: size, MtimeNS: stat.ModifiedNS}
		out.ObservationToken, err = state.seal(inputToken{Kind: "file", Scope: inputActorScope(s.request.WorkspaceID, s.request.ActorScope), Expires: now.Add(inputObservationTTL).Unix(), Observation: &observation})
		if err != nil {
			var typed *Error
			if errors.As(err, &typed) && typed.Code == "observation_too_large" {
				out.UnavailableReason = typed.Code
				return out, nil
			}
			return out, err
		}
		out.CanSelect = true
	case unix.S_IFLNK:
		out.UnavailableReason = "symlink_not_allowed"
	default:
		out.UnavailableReason = "unsupported_file"
	}
	return out, nil
}
func (f *Files) ObserveInput(ctx context.Context, workspace, rootID, relative, actorScope, token string) (InputObservation, error) {
	var empty InputObservation
	if actorScope == "" || len(actorScope) > 512 {
		return empty, inputBrowseInvalid()
	}
	root, config, err := f.inputRoot(workspace, rootID, relative)
	if err != nil {
		return empty, err
	}
	state, err := f.inputStateReady()
	if err != nil {
		return empty, err
	}
	claim, err := state.decode(token, "file", inputActorScope(workspace, actorScope), time.Now())
	if err != nil {
		return empty, err
	}
	if claim.Observation == nil {
		return empty, inputSourceChanged()
	}
	expected := *claim.Observation
	if expected.WorkspaceID != workspace || expected.RootID != rootID || expected.RelativePath != relative || expected.RootPath != root.Path || expected.RootConfigHash != config {
		return empty, inputSourceChanged()
	}
	reader, err := f.OpenInput(ctx, expected)
	if err != nil {
		return empty, err
	}
	if err = reader.Close(); err != nil {
		return empty, err
	}
	return expected, nil
}
func (f *Files) OpenInput(ctx context.Context, expected InputObservation) (io.ReadCloser, error) {
	root, config, err := f.inputRoot(expected.WorkspaceID, expected.RootID, expected.RelativePath)
	if err != nil {
		return nil, err
	}
	if root.Path != expected.RootPath || config != expected.RootConfigHash {
		return nil, fail("root_config_changed", "The configured input scope changed. The original source was not replaced.", false)
	}
	state, err := f.inputStateReady()
	if err != nil {
		return nil, err
	}
	release, err := state.acquireFile(ctx)
	if err != nil {
		return nil, err
	}
	held, err := openInputObservedFile(ctx, root, expected.RelativePath)
	if err != nil {
		release()
		return nil, err
	}
	current := InputObservation{WorkspaceID: expected.WorkspaceID, RootID: expected.RootID, RootPath: root.Path, RootConfigHash: config, RootIdentity: held.rootIdentity, RelativePath: expected.RelativePath, FileIdentity: held.original.identity(), SizeBytes: held.original.Size, MtimeNS: held.original.ModifiedNS}
	if current != expected {
		held.closeFiles()
		release()
		return nil, inputSourceChanged()
	}
	return &inputReleasedReader{ReadCloser: held, release: release}, nil
}
