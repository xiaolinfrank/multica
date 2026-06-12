package fleet

import (
	"context"
	"errors"
	"testing"
)

func TestApplyMetricsFullOutput(t *testing.T) {
	// page size 16384, total 16 GiB = 17179869184 bytes.
	// used pages = active 200000 + wired 100000 + comp 50000 = 350000
	// used bytes = 350000 * 16384 = 5734400000 → 33.4% of 16 GiB.
	out := `
hostname=fosun-agent-1.local
os=14.5
ncpu=10
cpu_idle=82.5
load1=2.30
mem_total=17179869184
page_size=16384
pg_active=200000
pg_wired=100000
pg_comp=50000
disk_used_pct=47
uptime_sec=123456
docker=running
containers=3
`
	var st DeviceStatus
	applyMetrics(&st, out)

	if st.Hostname != "fosun-agent-1.local" {
		t.Errorf("hostname = %q", st.Hostname)
	}
	if st.OS != "14.5" {
		t.Errorf("os = %q", st.OS)
	}
	if st.NCPU != 10 {
		t.Errorf("ncpu = %d", st.NCPU)
	}
	if st.CPUPercent != 17.5 {
		t.Errorf("cpu_percent = %v, want 17.5", st.CPUPercent)
	}
	if st.Load1 != 2.30 {
		t.Errorf("load1 = %v", st.Load1)
	}
	if st.DiskUsedPercent != 47 {
		t.Errorf("disk = %v", st.DiskUsedPercent)
	}
	if st.UptimeSeconds != 123456 {
		t.Errorf("uptime = %d", st.UptimeSeconds)
	}
	if st.MemUsedPercent < 33 || st.MemUsedPercent > 34 {
		t.Errorf("mem_used_percent = %v, want ~33.4", st.MemUsedPercent)
	}
	if st.Docker != "running" {
		t.Errorf("docker = %q", st.Docker)
	}
	if st.Containers != 3 {
		t.Errorf("containers = %d", st.Containers)
	}
}

// A truncated / garbage probe must not panic or invent values — fields stay at
// their zero values. This is the fail-closed contract for a flaky node.
func TestApplyMetricsPartialOutput(t *testing.T) {
	var st DeviceStatus
	st.Docker = "unknown"
	applyMetrics(&st, "hostname=foo\ngarbage line without equals\nload1=\nmem_total=0\n")

	if st.Hostname != "foo" {
		t.Errorf("hostname = %q", st.Hostname)
	}
	if st.CPUPercent != 0 {
		t.Errorf("cpu_percent should default to 0, got %v", st.CPUPercent)
	}
	if st.MemUsedPercent != 0 {
		t.Errorf("mem_used_percent should default to 0 when total is 0, got %v", st.MemUsedPercent)
	}
	if st.Docker != "unknown" {
		t.Errorf("docker should stay unknown when absent, got %q", st.Docker)
	}
}

func TestClampPct(t *testing.T) {
	cases := map[float64]float64{-5: 0, 0: 0, 33.44: 33.4, 100.5: 100, 50.06: 50.1}
	for in, want := range cases {
		if got := clampPct(in); got != want {
			t.Errorf("clampPct(%v) = %v, want %v", in, got, want)
		}
	}
}

// collectOne with an injected failing runner marks the device offline and
// keeps it in the result set rather than dropping it.
func TestCollectOfflineDeviceStaysVisible(t *testing.T) {
	c := New([]Device{
		{ID: "n1", Name: "n1", Host: "10.0.0.1", User: "n1", Port: 22},
	})
	c.cacheTTL = 0
	c.runRemote = func(ctx context.Context, d Device, script string) (string, error) {
		return "", errors.New("ssh: connect to host 10.0.0.1 port 22: Operation timed out")
	}

	got, _ := c.Collect(context.Background())
	if len(got) != 1 {
		t.Fatalf("expected 1 device, got %d", len(got))
	}
	if got[0].Online {
		t.Error("device should be offline")
	}
	if got[0].Error == "" {
		t.Error("offline device should carry an error reason")
	}
	if got[0].ID != "n1" {
		t.Errorf("id = %q", got[0].ID)
	}
}

// Local devices probe via runLocal, not SSH.
func TestCollectLocalUsesLocalRunner(t *testing.T) {
	c := New([]Device{{ID: "local", Name: "本机", Host: "localhost", Local: true}})
	c.cacheTTL = 0
	localCalled := false
	c.runLocal = func(ctx context.Context, script string) (string, error) {
		localCalled = true
		return "hostname=coordinator\ndocker=running\ncontainers=1\n", nil
	}
	c.runRemote = func(ctx context.Context, d Device, script string) (string, error) {
		t.Fatal("local device must not use the remote runner")
		return "", nil
	}

	got, _ := c.Collect(context.Background())
	if !localCalled {
		t.Error("runLocal was not invoked for a local device")
	}
	if !got[0].Online || got[0].Hostname != "coordinator" || got[0].Containers != 1 {
		t.Errorf("unexpected local status: %+v", got[0])
	}
}

func TestLoadDevicesFallsBackToDefaults(t *testing.T) {
	t.Setenv(EnvDevicesFile, "/nonexistent/path/devices.json")
	got := LoadDevices()
	if len(got) == 0 {
		t.Fatal("expected built-in defaults, got none")
	}
	if !got[0].Local {
		t.Error("first default device should be the local coordinator")
	}
	for _, d := range got {
		if d.Port == 0 {
			t.Errorf("device %s has un-normalized port 0", d.ID)
		}
		if d.Labels == nil {
			t.Errorf("device %s has nil labels", d.ID)
		}
	}
}
