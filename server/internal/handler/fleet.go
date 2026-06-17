package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/fleet"
)

// GetFleetStatus returns a live snapshot of the compute pool (the coordinator
// host plus the LAN Mac workers). The device list is global infrastructure
// config rather than workspace data, so the endpoint only gates on workspace
// membership — any member may view fleet health — and does not filter by
// workspace. See internal/fleet for the collector.
//
// On top of the raw SSH system probe, each device is overlaid with its
// daemon/runtime state for the *current* workspace (online, providers, live
// task load), turning the dashboard into a cluster control plane.
func (h *Handler) GetFleetStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}

	if h.Fleet == nil {
		// Collector not wired (e.g. minimal test harness) — degrade to empty
		// rather than 500 so the dashboard renders its empty state.
		writeJSON(w, http.StatusOK, map[string]any{
			"devices":      []any{},
			"collected_at": "",
		})
		return
	}

	devices, at := h.Fleet.Collect(r.Context())
	overlay := h.fleetRuntimeOverlay(r.Context(), workspaceID)

	// Copy each cached DeviceStatus before enriching: Collect returns the
	// shared cache slice, so mutating elements in place would poison it.
	enriched := make([]fleet.DeviceStatus, len(devices))
	for i, d := range devices {
		if d.Providers == nil {
			d.Providers = []string{}
		}
		// Correlate by daemon device name (== Fleet device id for workers,
		// set via `--device-name`) and fall back to hostname for the
		// coordinator, whose daemon registers under its hostname.
		if ov, ok := overlay[d.ID]; ok {
			applyRuntimeOverlay(&d, ov)
		} else if d.Hostname != "" {
			if ov, ok := overlay[d.Hostname]; ok {
				applyRuntimeOverlay(&d, ov)
			}
		}
		enriched[i] = d
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"devices":      enriched,
		"collected_at": at.UTC().Format(time.RFC3339),
	})
}

// runtimeAgg aggregates every runtime row that belongs to one physical device
// (a device runs one runtime per provider: hermes, claude, …).
type runtimeAgg struct {
	online    bool
	providers []string
	running   int
	queued    int
	version   string
}

func applyRuntimeOverlay(d *fleet.DeviceStatus, ov *runtimeAgg) {
	d.RuntimeOnline = ov.online
	d.Providers = ov.providers
	d.RunningTasks = ov.running
	d.QueuedTasks = ov.queued
	d.DaemonVersion = ov.version
}

// fleetRuntimeOverlay builds a map from daemon device name to the aggregated
// runtime/load state for the workspace. Keyed by the device-name prefix of
// device_info (everything before the " · <version>" suffix the daemon appends).
// Returns an empty map on any query error so the dashboard degrades to
// system-metrics-only rather than failing.
func (h *Handler) fleetRuntimeOverlay(ctx context.Context, workspaceID string) map[string]*runtimeAgg {
	out := map[string]*runtimeAgg{}
	rows, err := h.Queries.ListAgentRuntimesWithLoadByWorkspace(ctx, parseUUID(workspaceID))
	if err != nil {
		return out
	}
	for _, rt := range rows {
		name := deviceNameFromInfo(rt.DeviceInfo)
		if name == "" {
			continue
		}
		agg := out[name]
		if agg == nil {
			agg = &runtimeAgg{}
			out[name] = agg
		}
		if rt.Status == "online" {
			agg.online = true
		}
		if rt.Provider != "" && !contains(agg.providers, rt.Provider) {
			agg.providers = append(agg.providers, rt.Provider)
		}
		agg.running += int(rt.RunningTasks)
		agg.queued += int(rt.QueuedTasks)
		if agg.version == "" {
			if v := cliVersionFromMetadata(rt.Metadata); v != "" {
				agg.version = v
			}
		}
	}
	return out
}

// deviceNameFromInfo extracts the daemon device name from a device_info string
// like "fosun_agent_2 · Hermes Agent v0.12.0 (…)" -> "fosun_agent_2".
func deviceNameFromInfo(info string) string {
	if i := strings.Index(info, " · "); i >= 0 {
		return strings.TrimSpace(info[:i])
	}
	return strings.TrimSpace(info)
}

func cliVersionFromMetadata(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	if v, ok := m["cli_version"].(string); ok {
		return v
	}
	return ""
}
