// Package fleet collects live system status from the BayClaw compute pool —
// the coordinator host plus a set of LAN Mac nodes reachable over SSH. The
// device list is infrastructure configuration (a JSON inventory file), not
// workspace data, so it lives in the repo / an env-pointed file rather than
// the database. See deploy/fleet/ for the inventory and provisioning scripts.
package fleet

import (
	"encoding/json"
	"log/slog"
	"os"
)

// Device is one node in the compute pool. Loaded from the JSON inventory.
//
// A device with Local=true is the coordinator host the server runs on; its
// metrics are gathered by executing the probe locally instead of over SSH.
type Device struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Host   string   `json:"host"`
	User   string   `json:"user,omitempty"`
	Port   int      `json:"port,omitempty"`
	Local  bool     `json:"local,omitempty"`
	Labels []string `json:"labels,omitempty"`
}

// EnvDevicesFile is the environment variable that overrides the inventory path.
const EnvDevicesFile = "FLEET_DEVICES_FILE"

// defaultDevicesFile is resolved relative to the server's working directory.
const defaultDevicesFile = "deploy/fleet/devices.json"

// defaultDevices is the built-in BayClaw 大湾区 compute pool. It is used when
// no inventory file is present so the dashboard renders out of the box, and it
// is the source of truth that deploy/fleet/devices.json mirrors.
var defaultDevices = []Device{
	{ID: "local", Name: "本机 · Coordinator", Host: "localhost", Local: true, Labels: []string{"coordinator"}},
	{ID: "fosun_agent_1", Name: "fosun_agent_1", Host: "10.35.182.4", User: "fosun_agent_1", Labels: []string{"worker"}},
	{ID: "fosun_agent_2", Name: "fosun_agent_2", Host: "10.35.182.31", User: "fosun_agent_2", Labels: []string{"worker"}},
	{ID: "fosun_agent_3", Name: "fosun_agent_3", Host: "10.35.182.39", User: "fosun_agent_3", Labels: []string{"worker"}},
	{ID: "fosun_agent_4", Name: "fosun_agent_4", Host: "10.35.182.34", User: "fosun_agent_4", Labels: []string{"worker"}},
	{ID: "fosun_agent_5", Name: "fosun_agent_5", Host: "10.35.182.25", User: "fosun_agent_5", Labels: []string{"worker"}},
	{ID: "fosun_agent_6", Name: "fosun_agent_6", Host: "10.35.182.29", User: "fosun_agent_6", Labels: []string{"worker"}},
}

// LoadDevices reads the inventory from FLEET_DEVICES_FILE (or the default
// path). Any failure — missing file, bad JSON, empty list — falls back to the
// built-in pool so the endpoint never returns a hard error from a config typo.
func LoadDevices() []Device {
	path := os.Getenv(EnvDevicesFile)
	if path == "" {
		path = defaultDevicesFile
	}

	data, err := os.ReadFile(path)
	if err != nil {
		// Expected on most checkouts (the file ships under deploy/ but the
		// server may run from a different cwd) — debug, not warn.
		slog.Debug("fleet: inventory file not read, using built-in defaults", "path", path, "error", err)
		return normalizeDevices(defaultDevices)
	}

	var devices []Device
	if err := json.Unmarshal(data, &devices); err != nil || len(devices) == 0 {
		slog.Warn("fleet: inventory file invalid, using built-in defaults", "path", path, "error", err)
		return normalizeDevices(defaultDevices)
	}
	return normalizeDevices(devices)
}

// normalizeDevices fills in defaults (SSH port 22, non-nil labels) so the rest
// of the package never has to special-case zero values.
func normalizeDevices(in []Device) []Device {
	out := make([]Device, len(in))
	copy(out, in)
	for i := range out {
		if out[i].Port == 0 {
			out[i].Port = 22
		}
		if out[i].Labels == nil {
			out[i].Labels = []string{}
		}
	}
	return out
}
