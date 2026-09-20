package execenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The collaboration space ("人机协作空间路径") is the shared-storage directory a
// project or module binds to. It is the ONLY filesystem path the brief permits
// an agent to deliver to, which puts it in direct tension with the delivery
// invariant ("runtime-local paths are never deliverables"). These tests pin
// both halves: the section renders with the paths and the exception when a path
// exists, and NOTHING about it reaches a brief that has no path — that second
// half is what keeps every existing brief byte-identical (MUL-5377's prompt
// cache prefix) for the overwhelming majority of tasks that never set one.

const (
	collabProjectPath = "/Volumes/人机协作空间/AI医药联合创新平台"
	collabModulePath  = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）"

	collabSpaceHeading   = "### Collaboration Space"
	collabExceptionStart = "The one exception is this task's"
	collabModuleSentence = "Within that project, this task belongs to the module"
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

// A task bound to both a project path and a module path renders the section,
// both paths, and the delivery-invariant exception. The module path is named as
// the narrower of the two: an agent handed both and told nothing would pick
// either, and a deliverable in the project root is a deliverable filed under
// the wrong module.
func TestCollaborationSpaceRendersBothPaths(t *testing.T) {
	t.Parallel()

	ctx := collabIssueContext()
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ModuleTitle = "01高质量数据集"
	ctx.ModuleDescription = "回顾性队列数据集的清洗与标注规范。"
	ctx.ProjectCollabPath = collabProjectPath
	ctx.ModuleCollabPath = collabModulePath

	out := buildMetaSkillContent("claude", ctx)

	for _, want := range []string{
		"## Project Context",
		"Within that project, this task belongs to the module **01高质量数据集**.",
		"回顾性队列数据集的清洗与标注规范。",
		collabSpaceHeading,
		"- Project: `" + collabProjectPath + "`",
		"- Module: `" + collabModulePath + "`",
		"Use the module directory — it is the narrower of the two.",
		// The exception has to live next to the invariant it carves out of,
		// not only in Project Context: an agent about to hand a file over
		// recalls the rule, not the section three headings earlier.
		collabExceptionStart,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("brief missing %q", want)
		}
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

// One path alone still renders the section. The "use the module directory"
// steer is meaningless with a single path, so the copy must not claim a choice
// the agent does not have.
func TestCollaborationSpaceRendersASinglePath(t *testing.T) {
	t.Parallel()

	for name, mutate := range map[string]func(*TaskContextForEnv){
		"project only": func(c *TaskContextForEnv) {
			c.ProjectCollabPath = collabProjectPath
		},
		"module only": func(c *TaskContextForEnv) {
			// A module can point somewhere its project does not: the project
			// predates the shared storage, the module was set up on it.
			c.ModuleID = "44444444-5555-6666-7777-888888888888"
			c.ModuleTitle = "01高质量数据集"
			c.ModuleCollabPath = collabModulePath
		},
	} {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			ctx := collabIssueContext()
			mutate(&ctx)
			out := buildMetaSkillContent("claude", ctx)

			if !strings.Contains(out, collabSpaceHeading) {
				t.Fatalf("%s: brief missing %q", name, collabSpaceHeading)
			}
			if !strings.Contains(out, "Use that directory.") {
				t.Errorf("%s: single path must not offer a choice between two", name)
			}
			if strings.Contains(out, "Use the module directory") {
				t.Errorf("%s: brief steers to a module directory it never listed", name)
			}
			if !strings.Contains(out, collabExceptionStart) {
				t.Errorf("%s: delivery invariant keeps no exception for the one path there is", name)
			}
		})
	}
}

// A module with no collaboration path still names itself in Project Context —
// the module IS context, independent of shared storage — but must not open a
// Collaboration Space section with nothing to put in it.
func TestModuleContextWithoutCollabPathRendersNoSection(t *testing.T) {
	t.Parallel()

	ctx := collabIssueContext()
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ModuleTitle = "01高质量数据集"

	out := buildMetaSkillContent("claude", ctx)
	if !strings.Contains(out, "Within that project, this task belongs to the module **01高质量数据集**.") {
		t.Error("module without a collab path lost its Project Context sentence")
	}
	if strings.Contains(out, collabSpaceHeading) {
		t.Error("empty Collaboration Space section rendered for a module with no path")
	}
	if strings.Contains(out, collabExceptionStart) {
		t.Error("delivery invariant carved out an exception with no path behind it")
	}
}

// A module id with no title renders no module sentence: "the module ****" is
// worse than saying nothing, and a title is the only part of the module an
// agent can act on.
func TestModuleWithoutTitleRendersNoSentence(t *testing.T) {
	t.Parallel()

	ctx := collabIssueContext()
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ModuleCollabPath = collabModulePath

	out := buildMetaSkillContent("claude", ctx)
	if strings.Contains(out, collabModuleSentence) {
		t.Error("module sentence rendered without a title")
	}
	if !strings.Contains(out, "- Module: `"+collabModulePath+"`") {
		t.Error("module path dropped along with the untitled module")
	}
}

// The other half of the contract, and the one that protects every existing
// task: a brief with no collaboration path must carry NO trace of the feature,
// on any task kind, with or without project context. A string that leaks in
// unconditionally would rewrite the cached prefix of every brief in the fleet.
func TestBriefWithoutCollabPathCarriesNoCollaborationSpace(t *testing.T) {
	t.Parallel()

	withProject := collabIssueContext()
	moduleNoPath := collabIssueContext()
	moduleNoPath.ModuleID = "44444444-5555-6666-7777-888888888888"
	moduleNoPath.ModuleTitle = "01高质量数据集"

	kinds := map[string]TaskContextForEnv{
		"issue":                 {IssueID: "issue-1", AgentID: "a-1", AgentName: "Eve", AgentSkills: []SkillContextForEnv{platformSkillFixture()}},
		"issue with project":    withProject,
		"issue with module":     moduleNoPath,
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
		"Use that directory.",
		"Use the module directory",
		"shared storage is not mounted",
		collabProjectPath,
		collabModulePath,
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
func TestCollaborationSpaceIsTheOnlyBriefAddition(t *testing.T) {
	t.Parallel()

	baseline := buildMetaSkillContent("claude", collabIssueContext())

	ctx := collabIssueContext()
	ctx.ProjectCollabPath = collabProjectPath
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ModuleTitle = "01高质量数据集"
	ctx.ModuleCollabPath = collabModulePath
	variant := buildMetaSkillContent("claude", ctx)

	// The module sentence is part of the addition too; cut it as a paragraph.
	stripped := cutParagraph(t, variant, collabModuleSentence)
	// The section closes Project Context, so it runs from its own h3 heading to
	// the next h2 — located structurally, never by re-typing its prose.
	stripped = cutToNextHeading(t, stripped, collabSpaceHeading)
	stripped = cutParagraph(t, stripped, collabExceptionStart)

	if stripped != baseline {
		t.Errorf("a brief with a collaboration path differs from one without by more than the collaboration space:\n%s",
			firstBriefDiff(baseline, stripped))
	}
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
// copy a skill reads instead of parsing it. Both must carry the collaboration
// paths, and the file must be written for a task that has a module but no
// project resources at all — the gate used to be "project id or resources".
func TestProjectResourcesFileCarriesCollaborationSpace(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	ctx := collabIssueContext()
	ctx.ModuleID = "44444444-5555-6666-7777-888888888888"
	ctx.ModuleTitle = "01高质量数据集"
	ctx.ModuleDescription = "回顾性队列数据集的清洗与标注规范。"
	ctx.ProjectCollabPath = collabProjectPath
	ctx.ModuleCollabPath = collabModulePath

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
		ModuleCollabPath  string `json:"module_collab_path"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal resources.json: %v\n%s", err, raw)
	}
	if got.ProjectCollabPath != collabProjectPath {
		t.Errorf("project_collab_path = %q, want %q", got.ProjectCollabPath, collabProjectPath)
	}
	if got.ModuleCollabPath != collabModulePath {
		t.Errorf("module_collab_path = %q, want %q", got.ModuleCollabPath, collabModulePath)
	}
	if got.ModuleID != ctx.ModuleID || got.ModuleTitle != ctx.ModuleTitle || got.ModuleDescription != ctx.ModuleDescription {
		t.Errorf("module fields = %+v, want the context's", got)
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
