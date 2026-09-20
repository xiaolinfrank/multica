package execenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The collaboration space ("人机协作空间路径") is the shared-storage directory a
// PROJECT binds to. It is the ONLY filesystem path the brief permits an agent
// to deliver to, which puts it in direct tension with the delivery invariant
// ("runtime-local paths are never deliverables"). These tests pin both halves:
// the section renders with the path and the exception when a path exists, and
// NOTHING about it reaches a brief that has no path — that second half is what
// keeps every existing brief byte-identical (MUL-5377's prompt cache prefix)
// for the overwhelming majority of tasks that never set one.
//
// Only the project stores a path. A module's directory sits inside the
// project's, named after the module, so the brief tells the agent to find the
// folder by name rather than handing it a second absolute path — one that could
// drift out of sync with the folder it names, and that someone would have to
// fill in correctly for every module. "No second absolute path in the section"
// is therefore an assertion in its own right below, not an incidental detail.

const (
	collabProjectPath = "/Volumes/人机协作空间/AI医药联合创新平台"
	collabModuleTitle = "01高质量数据集"

	collabSpaceHeading   = "### Collaboration Space"
	collabExceptionStart = "The one exception is this task's"
	collabFolderStart    = "Your work belongs under the folder named after this task's module"
	collabProjectLine    = "- Project directory: `"
)

// collabIssueContext is an issue brief carrying project context and no
// collaboration path — the baseline every variant below mutates.
func collabIssueContext() TaskContextForEnv {
	return TaskContextForEnv{
		IssueID:            "11111111-2222-3333-4444-555555555555",
		AgentID:            "a-1",
		AgentName:          "Eve",
		ProjectID:          "22222222-3333-4444-5555-666666666666",
		ProjectTitle:       "AI医药联合创新平台",
		ProjectDescription: "Deliverables are reviewed by the clinical team before release.",
		AgentSkills:        []SkillContextForEnv{platformSkillFixture()},
	}
}

// collabModuleContext is the same brief with a module attached. The module is
// context in its own right — it renders in Project Context with or without a
// collaboration path — so it belongs in the BASELINE, not in the variant.
func collabModuleContext() TaskContextForEnv {
	ctx := collabIssueContext()
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ModuleTitle = collabModuleTitle
	ctx.ModuleDescription = "回顾性队列数据集的清洗与标注规范。"
	return ctx
}

// A task whose project names a collaboration space, on an issue that belongs to
// a module, renders the project directory once and locates the module's work by
// FOLDER NAME inside it. The second half is the design decision: the brief must
// not print a module path, because there is no stored module path to print and
// composing one here would re-invent the value the schema deliberately dropped.
func TestCollaborationSpaceNamesProjectPathAndModuleFolder(t *testing.T) {
	t.Parallel()

	ctx := collabModuleContext()
	ctx.ProjectCollabPath = collabProjectPath

	out := buildMetaSkillContent("claude", ctx)

	for _, want := range []string{
		"## Project Context",
		"Within that project, this task belongs to the module **" + collabModuleTitle + "**.",
		"回顾性队列数据集的清洗与标注规范。",
		collabSpaceHeading,
		collabProjectLine + collabProjectPath + "`",
		// The module is located by name, as a folder, inside the project
		// directory — and the copy says to create it, because a fresh module
		// has no directory yet and an agent that finds none must not fall back
		// to the project root.
		collabFolderStart + ", `" + collabModuleTitle + "/`, inside that directory.",
		"Create it if it is not there yet.",
		// The exception has to live next to the invariant it carves out of,
		// not only in Project Context: an agent about to hand a file over
		// recalls the rule, not the section three headings earlier.
		collabExceptionStart,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("brief missing %q", want)
		}
	}

	// The load-bearing negative: exactly ONE absolute path in the section, and
	// it is the project's. A reintroduced module path — stored, or composed
	// here from project+title — shows up as a second one.
	section := collabSection(t, out)
	paths := absolutePathsIn(section)
	if len(paths) != 1 || paths[0] != collabProjectPath {
		t.Errorf("Collaboration Space names absolute paths %q, want exactly [%q]", paths, collabProjectPath)
	}
	if composed := collabProjectPath + "/" + collabModuleTitle; strings.Contains(out, composed) {
		t.Errorf("brief composes a module path %q — the module folder is named, never spelled out as a path", composed)
	}

	// Project Context owns the section: it is an h3 and must sit inside that
	// h2, not escape into whatever section follows.
	projectCtx := strings.Index(out, "## Project Context")
	space := strings.Index(out, collabSpaceHeading)
	nextSection := projectCtx + strings.Index(out[projectCtx:], "\n## ")
	if projectCtx < 0 || space < projectCtx || space > nextSection {
		t.Errorf("Collaboration Space at %d is not nested inside Project Context (%d..%d)", space, projectCtx, nextSection)
	}
	// The exception belongs to the Output section's invariant, which comes after.
	if invariant, exception := strings.Index(out, "**Runtime-local paths are never deliverables.**"), strings.Index(out, collabExceptionStart); invariant < 0 || exception < invariant {
		t.Errorf("delivery exception at %d does not follow the invariant at %d", exception, invariant)
	}
}

// Most tasks with a collaboration space have no module. The section still
// renders — the project directory IS the destination then — and must not emit a
// folder line naming nothing.
func TestCollaborationSpaceWithoutModuleHasNoFolderLine(t *testing.T) {
	t.Parallel()

	ctx := collabIssueContext()
	ctx.ProjectCollabPath = collabProjectPath

	out := buildMetaSkillContent("claude", ctx)

	if !strings.Contains(out, collabSpaceHeading) {
		t.Fatalf("brief missing %q", collabSpaceHeading)
	}
	if !strings.Contains(out, collabProjectLine+collabProjectPath+"`") {
		t.Error("project directory dropped from a brief that has one")
	}
	if strings.Contains(out, collabFolderStart) {
		t.Error("brief points at a module folder for a task with no module")
	}
	if !strings.Contains(out, collabExceptionStart) {
		t.Error("delivery invariant keeps no exception for the path there is")
	}
	if paths := absolutePathsIn(collabSection(t, out)); len(paths) != 1 || paths[0] != collabProjectPath {
		t.Errorf("Collaboration Space names absolute paths %q, want exactly [%q]", paths, collabProjectPath)
	}
}

// A module id with no title names no folder: a bare "/" folder is worse than
// saying nothing, and the title is the only part of a module the folder can be
// named after. The project directory still stands on its own.
func TestCollaborationSpaceModuleWithoutTitleHasNoFolderLine(t *testing.T) {
	t.Parallel()

	ctx := collabIssueContext()
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ProjectCollabPath = collabProjectPath

	out := buildMetaSkillContent("claude", ctx)
	if strings.Contains(out, collabFolderStart) {
		t.Error("folder line rendered for a module with no title")
	}
	if !strings.Contains(out, collabProjectLine+collabProjectPath+"`") {
		t.Error("project directory dropped along with the untitled module")
	}
}

// A module with no PROJECT collaboration path still names itself in Project
// Context — the module IS context, independent of shared storage — but must not
// open a Collaboration Space section with nothing to put in it. The module no
// longer has a path of its own, so the project's absence is the whole gate.
func TestModuleContextWithoutProjectCollabPathRendersNoSection(t *testing.T) {
	t.Parallel()

	out := buildMetaSkillContent("claude", collabModuleContext())
	if !strings.Contains(out, "Within that project, this task belongs to the module **"+collabModuleTitle+"**.") {
		t.Error("module without a project collab path lost its Project Context sentence")
	}
	if strings.Contains(out, collabSpaceHeading) {
		t.Error("empty Collaboration Space section rendered for a project with no path")
	}
	if strings.Contains(out, collabFolderStart) {
		t.Error("folder line rendered with no directory to put the folder in")
	}
	if strings.Contains(out, collabExceptionStart) {
		t.Error("delivery invariant carved out an exception with no path behind it")
	}
}

// The other half of the contract, and the one that protects every existing
// task: a brief with no collaboration path must carry NO trace of the feature,
// on any task kind, with or without project or module context. A string that
// leaks in unconditionally would rewrite the cached prefix of every brief in
// the fleet.
func TestBriefWithoutCollabPathCarriesNoCollaborationSpace(t *testing.T) {
	t.Parallel()

	kinds := map[string]TaskContextForEnv{
		"issue":                 {IssueID: "issue-1", AgentID: "a-1", AgentName: "Eve", AgentSkills: []SkillContextForEnv{platformSkillFixture()}},
		"issue with project":    collabIssueContext(),
		"issue with module":     collabModuleContext(),
		"chat":                  {ChatSessionID: "chat-1", ChatChannelType: ChannelTypeSlack, AgentID: "a-1", AgentName: "Eve"},
		"autopilot":             {AutopilotRunID: "run-1", AutopilotID: "ap-1", AgentID: "a-1", AgentName: "Eve"},
		"quick-create":          {QuickCreatePrompt: "make an issue", AgentID: "a-1", AgentName: "Eve"},
		"chat with project":     {ChatSessionID: "chat-1", AgentID: "a-1", AgentName: "Eve", ProjectID: "p-1", ProjectTitle: "AI医药联合创新平台"},
		"issue, no project ctx": {IssueID: "issue-2", AgentID: "a-1", AgentName: "Eve"},
	}

	banned := []string{
		collabSpaceHeading,
		"Collaboration Space",
		"collaboration space",
		collabExceptionStart,
		collabFolderStart,
		"Project directory:",
		"Shared storage where this team's",
		"shared storage is not mounted",
		collabProjectPath,
	}

	for name, ctx := range kinds {
		name, ctx := name, ctx
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			out := buildMetaSkillContent("claude", ctx)
			for _, leak := range banned {
				if strings.Contains(out, leak) {
					t.Errorf("%s brief carries %q with no collaboration path set", name, leak)
				}
			}
		})
	}
}

// Byte-equality, stated as a subtraction: removing the collaboration-space
// block and the delivery exception from a brief that HAS a path must restore
// the brief that does not, byte for byte.
//
// Asserting the absent strings (above) catches a new sentence that names the
// feature. This catches the rest — a reflowed blank line, a moved section, a
// sentence rewritten "while we're here" — anywhere in the brief, without the
// test re-typing the implementation's prose and becoming a second copy to
// drift from.
//
// The module paragraph is NOT part of the subtraction: it renders identically
// on both sides, which is itself the check that module context and the
// collaboration space are now independent of each other.
func TestCollaborationSpaceIsTheOnlyBriefAddition(t *testing.T) {
	t.Parallel()

	baseline := buildMetaSkillContent("claude", collabModuleContext())

	ctx := collabModuleContext()
	ctx.ProjectCollabPath = collabProjectPath
	variant := buildMetaSkillContent("claude", ctx)

	// The section closes Project Context, so it runs from its own h3 heading to
	// the next h2 — located structurally, never by re-typing its prose.
	stripped := cutToNextHeading(t, variant, collabSpaceHeading)
	stripped = cutParagraph(t, stripped, collabExceptionStart)

	if stripped != baseline {
		t.Errorf("a brief with a collaboration path differs from one without by more than the collaboration space:\n%s",
			firstBriefDiff(baseline, stripped))
	}
}

// Whether the agent may NAME the path it wrote is a property of the SURFACE,
// not of the collaboration space: quick-create's stdout is a single templated
// line, so telling it to name the path would order it to break a hard guardrail
// stated in the same brief. Every other kind has somewhere to put the path and
// is told which one, in that surface's own words.
func TestCollaborationSpaceReportingSentencePerTaskKind(t *testing.T) {
	t.Parallel()

	project := TaskContextForEnv{
		AgentID:           "a-1",
		AgentName:         "Eve",
		ProjectID:         "22222222-3333-4444-5555-666666666666",
		ProjectTitle:      "AI医药联合创新平台",
		ProjectCollabPath: collabProjectPath,
	}
	withKind := func(mutate func(*TaskContextForEnv)) TaskContextForEnv {
		ctx := project
		mutate(&ctx)
		return ctx
	}

	cases := map[string]struct {
		ctx  TaskContextForEnv
		want string
	}{
		"issue": {
			ctx:  withKind(func(c *TaskContextForEnv) { c.IssueID = "issue-1" }),
			want: "Name the path you wrote in your issue comment, as plain text, so a person can open it.",
		},
		"chat": {
			ctx: withKind(func(c *TaskContextForEnv) {
				c.ChatSessionID, c.ChatChannelType = "chat-1", ChannelTypeSlack
			}),
			want: "Name the path you wrote in your reply, as plain text, so the reader can open it.",
		},
		"autopilot": {
			ctx: withKind(func(c *TaskContextForEnv) {
				c.AutopilotRunID, c.AutopilotID = "run-1", "ap-1"
			}),
			want: "Name the path you wrote in your run result, as plain text, so a person can open it.",
		},
		"quick-create": {
			ctx:  withKind(func(c *TaskContextForEnv) { c.QuickCreatePrompt = "make an issue" }),
			want: "Do not name the path in your output:",
		},
	}

	for name, tc := range cases {
		name, tc := name, tc
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			out := buildMetaSkillContent("claude", tc.ctx)
			if !strings.Contains(out, collabSpaceHeading) {
				t.Fatalf("%s: no Collaboration Space section to report from", name)
			}
			if !strings.Contains(out, tc.want) {
				t.Errorf("%s: brief missing its reporting sentence %q", name, tc.want)
			}
			// Every other kind's sentence must be absent: one surface getting
			// two contradictory instructions is the failure this guards.
			for other, o := range cases {
				if other == name {
					continue
				}
				if strings.Contains(out, o.want) {
					t.Errorf("%s brief also carries the %s reporting sentence %q", name, other, o.want)
				}
			}
		})
	}
}

// collabSection returns the Collaboration Space block: its h3 heading through
// the next top-level heading.
func collabSection(t *testing.T, brief string) string {
	t.Helper()
	i := strings.Index(brief, collabSpaceHeading)
	if i < 0 {
		t.Fatalf("collabSection: %q not found", collabSpaceHeading)
	}
	rest := brief[i:]
	if j := strings.Index(rest, "\n## "); j >= 0 {
		return rest[:j]
	}
	return rest
}

// absolutePathsIn returns the backtick-quoted spans in s that could be resolved
// as a filesystem path on a daemon host — POSIX, UNC or Windows drive. The
// brief quotes several non-path things in backticks (`## Output`, the module
// folder name), so the filter is what makes "how many paths does this section
// hand the agent" answerable.
func absolutePathsIn(s string) []string {
	var out []string
	parts := strings.Split(s, "`")
	for i := 1; i < len(parts); i += 2 {
		if looksAbsolutePath(parts[i]) {
			out = append(out, parts[i])
		}
	}
	return out
}

func looksAbsolutePath(v string) bool {
	switch {
	case strings.HasPrefix(v, `\\`):
		return true
	case strings.HasPrefix(v, "/"):
		return true
	case len(v) >= 3 && v[1] == ':' && (v[2] == '/' || v[2] == '\\'):
		return true
	}
	return false
}

// cutToNextHeading removes the block running from start to the first following
// top-level "## " heading, keeping that heading.
func cutToNextHeading(t *testing.T, s, start string) string {
	t.Helper()
	i := strings.Index(s, start)
	if i < 0 {
		t.Fatalf("cutToNextHeading: %q not found", start)
	}
	j := strings.Index(s[i:], "\n## ")
	if j < 0 {
		t.Fatalf("cutToNextHeading: no top-level heading after %q", start)
	}
	return s[:i] + s[i+j+1:]
}

// cutParagraph removes the paragraph beginning at start, including its
// trailing blank line.
func cutParagraph(t *testing.T, s, start string) string {
	t.Helper()
	i := strings.Index(s, start)
	if i < 0 {
		t.Fatalf("cutParagraph: %q not found", start)
	}
	j := strings.Index(s[i:], "\n\n")
	if j < 0 {
		t.Fatalf("cutParagraph: no paragraph break after %q", start)
	}
	return s[:i] + s[i+j+2:]
}

// The brief is prose; `.multica/project/resources.json` is the machine-readable
// copy a skill reads instead of parsing it. It must carry the project path and
// the module identity — and NO module path: a skill that reads a
// `module_collab_path` key is a second place the removed value would have to be
// kept in sync. The file must also be written for a task that has a module but
// no project resources at all — the gate used to be "project id or resources".
func TestProjectResourcesFileCarriesProjectCollabPathOnly(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	ctx := collabModuleContext()
	ctx.ProjectCollabPath = collabProjectPath

	if err := writeProjectResources(dir, ctx, &sidecarManifest{}); err != nil {
		t.Fatalf("writeProjectResources: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".multica", "project", "resources.json"))
	if err != nil {
		t.Fatalf("read resources.json: %v", err)
	}

	var got struct {
		ProjectID         string `json:"project_id"`
		ProjectCollabPath string `json:"project_collab_path"`
		ModuleID          string `json:"module_id"`
		ModuleTitle       string `json:"module_title"`
		ModuleDescription string `json:"module_description"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal resources.json: %v\n%s", err, raw)
	}
	if got.ProjectCollabPath != collabProjectPath {
		t.Errorf("project_collab_path = %q, want %q", got.ProjectCollabPath, collabProjectPath)
	}
	if got.ModuleID != ctx.ModuleID || got.ModuleTitle != ctx.ModuleTitle || got.ModuleDescription != ctx.ModuleDescription {
		t.Errorf("module fields = %+v, want the context's", got)
	}

	// Key-level, not field-level: an unknown key would decode silently into the
	// struct above and leave this test green.
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatalf("unmarshal resources.json as an object: %v\n%s", err, raw)
	}
	if _, ok := keys["module_collab_path"]; ok {
		t.Errorf("resources.json still carries module_collab_path: %s", raw)
	}
	for key := range keys {
		if strings.Contains(key, "collab_path") && key != "project_collab_path" {
			t.Errorf("unexpected collaboration-path key %q in resources.json: %s", key, raw)
		}
	}
}

// A task with neither project nor module nor resources writes no sidecar at
// all: the file exists to carry context, and an empty one is a file every
// local_directory run has to clean up for nothing.
func TestProjectResourcesFileSkippedWithoutContext(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	if err := writeProjectResources(dir, TaskContextForEnv{IssueID: "issue-1"}, &sidecarManifest{}); err != nil {
		t.Fatalf("writeProjectResources: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".multica", "project", "resources.json")); !os.IsNotExist(err) {
		t.Fatalf("resources.json written for a task with no project context (stat err = %v)", err)
	}
}
