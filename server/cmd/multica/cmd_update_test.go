package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestRunUpdateRejectsNonPositiveDownloadTimeout(t *testing.T) {
	orig := updateDownloadTimeout
	updateDownloadTimeout = 0
	t.Cleanup(func() { updateDownloadTimeout = orig })

	err := runUpdate(nil, nil)
	if err == nil || !strings.Contains(err.Error(), "download timeout must be greater than zero") {
		t.Fatalf("runUpdate error = %v, want download timeout validation", err)
	}
}

func TestRunUpdateFailsClosedInTaskContext(t *testing.T) {
	origVersion := version
	version = "0.6.2"
	t.Cleanup(func() { version = origVersion })

	t.Setenv("MULTICA_AGENT_ID", "agent-test")
	t.Setenv("MULTICA_TASK_ID", "task-test")
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", filepath.Join(t.TempDir(), "task-multica"))

	err := runUpdate(nil, nil)
	if err == nil || !strings.Contains(err.Error(), "not available inside a daemon-managed task") {
		t.Fatalf("runUpdate error = %v, want task-context guard", err)
	}
}

func TestRunUpdateRejectsCustomOrSourceBuild(t *testing.T) {
	for _, k := range []string{"MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_TASK_CONFIG_ROOT", "MULTICA_DAEMON_PORT"} {
		t.Setenv(k, "")
	}
	for _, buildVer := range []string{"dev", "v0.6.0-341-g74eded2ab-inventory-ab"} {
		t.Run(buildVer, func(t *testing.T) {
			origVersion := version
			version = buildVer
			t.Cleanup(func() { version = origVersion })

			err := runUpdate(nil, nil)
			if err == nil || !strings.Contains(err.Error(), "disabled for custom/source build") {
				t.Fatalf("runUpdate(%q) error = %v, want custom/source build guard", buildVer, err)
			}
		})
	}
}

func TestRunUpdateRejectsMacOSAppBundle(t *testing.T) {
	for _, k := range []string{"MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_TASK_CONFIG_ROOT", "MULTICA_DAEMON_PORT"} {
		t.Setenv(k, "")
	}
	origVersion := version
	origResolve := resolveSelfExecForUpdate
	version = "0.6.2"
	resolveSelfExecForUpdate = func() (string, error) {
		return "/Users/example/Applications/BayClawFleet.app/Contents/MacOS/multica", nil
	}
	t.Cleanup(func() {
		version = origVersion
		resolveSelfExecForUpdate = origResolve
	})

	err := runUpdate(nil, nil)
	if err == nil || !strings.Contains(err.Error(), "cannot self-update binary inside a macOS .app bundle") {
		t.Fatalf("runUpdate error = %v, want macOS .app bundle guard", err)
	}
}
