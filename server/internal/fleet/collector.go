package fleet

import (
	"bufio"
	"context"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
)

// DeviceStatus is the per-device snapshot the dashboard renders. Every numeric
// field is best-effort: on collection failure Online=false and Error carries a
// short reason, but the device still appears (greyed) on the grid so an
// unreachable node is visible rather than silently dropped.
type DeviceStatus struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Host     string   `json:"host"`
	Labels   []string `json:"labels"`
	Local    bool     `json:"local"`
	Online   bool     `json:"online"`
	Hostname string   `json:"hostname"`
	OS       string   `json:"os"`

	CPUPercent      float64 `json:"cpu_percent"`
	MemUsedPercent  float64 `json:"mem_used_percent"`
	DiskUsedPercent float64 `json:"disk_used_percent"`
	Load1           float64 `json:"load1"`
	NCPU            int     `json:"ncpu"`
	UptimeSeconds   int64   `json:"uptime_seconds"`

	Docker     string `json:"docker"` // running | stopped | absent | unknown
	Containers int    `json:"containers"`

	// Hardware / thermal telemetry. GPU + thermal come from `powermetrics`
	// (root-only; fleet nodes have NOPASSWD sudo), network from a netstat
	// delta. All best-effort: where a sensor or sudo is unavailable the field
	// stays zero / empty (e.g. the coordinator without NOPASSWD powermetrics).
	Chip            string  `json:"chip"`              // e.g. "Apple M4"
	GPUPercent      float64 `json:"gpu_percent"`       // GPU active residency
	SystemPowerW    float64 `json:"system_power_w"`    // SoC total power (CPU+GPU+ANE), watts
	ThermalPressure string  `json:"thermal_pressure"`  // Nominal|Fair|Serious|Critical|""
	NetRxBytesSec   float64 `json:"net_rx_bytes_sec"`  // en0 receive throughput
	NetTxBytesSec   float64 `json:"net_tx_bytes_sec"`  // en0 transmit throughput

	// Cluster control-plane overlay. These are populated by the handler from
	// the agent_runtime table (correlated to this device by daemon device
	// name), not by the SSH probe — a node can be SSH-reachable while its
	// daemon is offline, so RuntimeOnline is tracked separately from Online.
	RuntimeOnline bool     `json:"runtime_online"`
	Providers     []string `json:"providers"`
	RunningTasks  int      `json:"running_tasks"`
	QueuedTasks   int      `json:"queued_tasks"`
	DaemonVersion string   `json:"daemon_version"`

	Error string `json:"error,omitempty"`
}

// metricsScript is a portable macOS probe that prints `key=value` lines. It is
// fed to `bash -s` (locally or over SSH); every command is guarded so a
// missing tool degrades one field instead of failing the whole probe.
const metricsScript = `
# Non-login SSH shells don't load the user profile, so Homebrew's bin dirs
# (where docker/colima live on these Macs) aren't on PATH. Add them explicitly
# or every node would report docker=absent even with the daemon running.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "hostname=$(hostname 2>/dev/null)"
echo "os=$(sw_vers -productVersion 2>/dev/null)"
echo "ncpu=$(sysctl -n hw.ncpu 2>/dev/null)"
idle=$(top -l 1 -n 0 2>/dev/null | awk -F'[, ]+' '/CPU usage/ {for (i=1;i<=NF;i++) if ($i ~ /idle/) print $(i-1)}' | tr -d '%')
echo "cpu_idle=${idle}"
echo "load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
echo "mem_total=$(sysctl -n hw.memsize 2>/dev/null)"
vm_stat 2>/dev/null | awk '
  /page size of/        {print "page_size="$8}
  /Pages active/        {gsub(/\./,"",$3); print "pg_active="$3}
  /Pages wired down/    {gsub(/\./,"",$4); print "pg_wired="$4}
  /occupied by compressor/ {gsub(/\./,"",$5); print "pg_comp="$5}
'
echo "disk_used_pct=$(df -k / 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')"
boot=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,}]+' '{print $4}')
now=$(date +%s)
if [ -n "$boot" ]; then echo "uptime_sec=$((now - boot))"; fi
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    echo "docker=running"
    echo "containers=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
  else
    echo "docker=stopped"
  fi
else
  echo "docker=absent"
fi
echo "chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
# GPU utilisation, system power and thermal pressure come from powermetrics,
# which is root-only. Fleet worker nodes have NOPASSWD sudo; where that's not
# granted (e.g. the coordinator) the call fails and these fields stay zero/empty.
# System power = CPU + GPU + ANE component power (Apple Silicon has no single
# package/wall-power line; this sum is the SoC total, same as asitop reports).
pm=$(sudo -n powermetrics -n 1 -i 200 --samplers cpu_power,gpu_power,thermal 2>/dev/null)
if [ -n "$pm" ]; then
  echo "gpu_pct=$(printf '%s\n' "$pm" | grep 'GPU HW active residency' | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')"
  cpu_mw=$(printf '%s\n' "$pm" | grep -m1 'CPU Power:' | grep -oE '[0-9]+' | head -1)
  gpu_mw=$(printf '%s\n' "$pm" | grep -m1 'GPU Power:' | grep -oE '[0-9]+' | head -1)
  ane_mw=$(printf '%s\n' "$pm" | grep -m1 'ANE Power:' | grep -oE '[0-9]+' | head -1)
  echo "sys_mw=$(awk -v a="${cpu_mw:-0}" -v b="${gpu_mw:-0}" -v c="${ane_mw:-0}" 'BEGIN{print a+b+c}')"
  echo "thermal=$(printf '%s\n' "$pm" | awk -F': ' '/pressure level/{print $2; exit}')"
fi
# Network throughput: sample the en0 byte counters twice and take the delta.
ns1=$(netstat -ibn 2>/dev/null | awk '$1=="en0"{print $7, $10; exit}')
sleep 0.6
ns2=$(netstat -ibn 2>/dev/null | awk '$1=="en0"{print $7, $10; exit}')
if [ -n "$ns1" ] && [ -n "$ns2" ]; then
  echo "net_rx_bps=$(awk -v a="${ns1% *}" -v b="${ns2% *}" 'BEGIN{d=(b-a)/0.6; if(d<0)d=0; print int(d)}')"
  echo "net_tx_bps=$(awk -v a="${ns1#* }" -v b="${ns2#* }" 'BEGIN{d=(b-a)/0.6; if(d<0)d=0; print int(d)}')"
fi
`

// Collector probes the configured devices, caching the last snapshot briefly so
// front-end polling doesn't open a fresh SSH connection on every request.
type Collector struct {
	devices  []Device
	timeout  time.Duration
	cacheTTL time.Duration

	mu       sync.Mutex
	cached   []DeviceStatus
	cachedAt time.Time

	// Command runners are fields so tests can inject deterministic output
	// without spawning real processes.
	runLocal  func(ctx context.Context, script string) (string, error)
	runRemote func(ctx context.Context, d Device, script string) (string, error)
}

// New builds a Collector for the given device list.
func New(devices []Device) *Collector {
	c := &Collector{
		devices:  devices,
		timeout:  10 * time.Second,
		cacheTTL: 5 * time.Second,
	}
	c.runLocal = execLocal
	c.runRemote = execRemote
	return c
}

// Devices returns the configured inventory (used by callers that want the list
// without triggering a probe).
func (c *Collector) Devices() []Device { return c.devices }

// Collect returns a snapshot of every device plus the time it was gathered.
// Within cacheTTL of the previous call it returns the cached snapshot.
func (c *Collector) Collect(ctx context.Context) ([]DeviceStatus, time.Time) {
	c.mu.Lock()
	if c.cached != nil && time.Since(c.cachedAt) < c.cacheTTL {
		cached, at := c.cached, c.cachedAt
		c.mu.Unlock()
		return cached, at
	}
	c.mu.Unlock()

	results := make([]DeviceStatus, len(c.devices))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(8)
	for i, d := range c.devices {
		i, d := i, d
		g.Go(func() error {
			results[i] = c.collectOne(gctx, d)
			return nil // a failed probe is a per-device state, never a group error
		})
	}
	_ = g.Wait()

	now := time.Now()
	c.mu.Lock()
	c.cached = results
	c.cachedAt = now
	c.mu.Unlock()
	return results, now
}

func (c *Collector) collectOne(ctx context.Context, d Device) DeviceStatus {
	st := DeviceStatus{
		ID:     d.ID,
		Name:   d.Name,
		Host:   d.Host,
		Labels: d.Labels,
		Local:  d.Local,
		Docker: "unknown",
	}
	if st.Labels == nil {
		st.Labels = []string{}
	}

	cctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	var (
		out string
		err error
	)
	if d.Local {
		out, err = c.runLocal(cctx, metricsScript)
	} else {
		out, err = c.runRemote(cctx, d, metricsScript)
	}
	if err != nil {
		st.Online = false
		st.Error = shortError(err, out)
		return st
	}

	st.Online = true
	applyMetrics(&st, out)
	return st
}

// applyMetrics parses the `key=value` probe output into st. It is the unit
// boundary the tests target: malformed or partial output leaves fields at
// their zero values rather than producing an error.
func applyMetrics(st *DeviceStatus, out string) {
	m := parseKV(out)

	if v, ok := m["hostname"]; ok && v != "" {
		st.Hostname = v
	}
	if v, ok := m["os"]; ok && v != "" {
		st.OS = v
	}
	st.NCPU = atoi(m["ncpu"])
	st.Load1 = atof(m["load1"])
	st.DiskUsedPercent = clampPct(atof(m["disk_used_pct"]))
	st.UptimeSeconds = atoi64(m["uptime_sec"])

	// CPU: probe reports idle %; usage is the complement.
	if idle, ok := m["cpu_idle"]; ok && idle != "" {
		st.CPUPercent = clampPct(100 - atof(idle))
	}

	// Memory: (active + wired + compressed) pages × page size / total bytes.
	pageSize := atof(m["page_size"])
	memTotal := atof(m["mem_total"])
	if pageSize > 0 && memTotal > 0 {
		usedBytes := (atof(m["pg_active"]) + atof(m["pg_wired"]) + atof(m["pg_comp"])) * pageSize
		st.MemUsedPercent = clampPct(usedBytes / memTotal * 100)
	}

	if v, ok := m["docker"]; ok && v != "" {
		st.Docker = v
	}
	st.Containers = atoi(m["containers"])

	if v, ok := m["chip"]; ok && v != "" {
		st.Chip = v
	}
	if v, ok := m["gpu_pct"]; ok && v != "" {
		st.GPUPercent = clampPct(atof(v))
	}
	if v, ok := m["sys_mw"]; ok && v != "" {
		st.SystemPowerW = float64(int(atof(v)/1000*100+0.5)) / 100 // mW → W, 2dp
	}
	if v, ok := m["thermal"]; ok && v != "" {
		st.ThermalPressure = v
	}
	st.NetRxBytesSec = atof(m["net_rx_bps"])
	st.NetTxBytesSec = atof(m["net_tx_bps"])
}

func parseKV(out string) map[string]string {
	m := make(map[string]string)
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok {
			continue
		}
		m[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return m
}

// execLocal runs the probe on the coordinator host.
func execLocal(ctx context.Context, script string) (string, error) {
	cmd := exec.CommandContext(ctx, "bash", "-s")
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.Output()
	return string(out), err
}

// execRemote runs the probe over SSH, reusing the host's configured keys and
// known_hosts. BatchMode fails fast instead of prompting; accept-new trusts a
// first-seen host so a freshly provisioned node doesn't wedge the dashboard.
func execRemote(ctx context.Context, d Device, script string) (string, error) {
	port := d.Port
	if port == 0 {
		port = 22
	}
	target := d.Host
	if d.User != "" {
		target = d.User + "@" + d.Host
	}
	args := []string{
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=5",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "LogLevel=ERROR",
		"-p", strconv.Itoa(port),
		target,
		"bash -s",
	}
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.Output()
	return string(out), err
}

// shortError produces a one-line, human-readable failure reason. For SSH
// connection failures the stderr tail is the useful part.
func shortError(err error, out string) string {
	var stderr string
	if ee, ok := err.(*exec.ExitError); ok {
		stderr = strings.TrimSpace(string(ee.Stderr))
	}
	if stderr != "" {
		if i := strings.LastIndexByte(stderr, '\n'); i >= 0 {
			stderr = stderr[i+1:]
		}
		return strings.TrimSpace(stderr)
	}
	return strings.TrimSpace(err.Error())
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	// Round to one decimal so the JSON is compact and the UI is stable.
	return float64(int(v*10+0.5)) / 10
}
