package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// collab_path ("人机协作空间路径") binds a PROJECT to a directory on shared NAS
// storage where people and agents hand finished work to each other. The server
// never stats it — it is resolved on whichever daemon host runs the task — so
// validation is the only gate between a typo and an agent writing a deliverable
// somewhere nobody looks.
//
// Only projects store one. A module's directory sits under its project's, named
// after the module, so the location is already derivable: a second stored path
// would be a value that can drift out of sync with the folder it names, a
// setting someone has to fill in correctly, and a second edit every time the
// module set is re-cut. The module API's side of that decision is pinned in
// module_test.go (TestModuleAPIIgnoresCollabPath).

// collabPathExample is the shape a real deployment stores: a CJK mount point,
// several levels deep, with full-width parentheses in the leaf.
const collabPathExample = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）"

// The validator's whole job is to separate "a path on SOME host" from "a value
// that cannot be a path anywhere". A relative value is the dangerous one: it
// resolves inside the task's private workdir, which is exactly the place the
// feature exists to keep deliverables out of, and it does so without an error
// anyone would ever see.
func TestNormalizeCollabPath(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		in string
		// want is the stored value; empty want with wantNull means the column
		// is cleared rather than rejected.
		want     string
		wantNull bool
		wantErr  string
	}{
		"posix absolute":        {in: "/Volumes/collab/project", want: "/Volumes/collab/project"},
		"posix cjk":             {in: "/Volumes/人机协作空间/项目", want: "/Volumes/人机协作空间/项目"},
		"real deployment value": {in: collabPathExample, want: collabPathExample},
		"filesystem root":       {in: "/", want: "/"},
		// A daemon fleet spans macOS, Linux and Windows, so the Windows forms
		// are as correct as the POSIX one — rejecting them would reject a value
		// that works everywhere the task can actually run.
		"unc share":                 {in: `\\nas\人机协作空间\项目`, want: `\\nas\人机协作空间\项目`},
		"windows drive with slash":  {in: "Z:/collab/project", want: "Z:/collab/project"},
		"windows drive with bslash": {in: `Z:\collab\project`, want: `Z:\collab\project`},
		"lowercase drive letter":    {in: `z:\collab`, want: `z:\collab`},
		// Paths get pasted out of Finder and file managers, which carry the
		// surrounding whitespace along with them.
		"surrounding whitespace trimmed": {in: "  \t/Volumes/collab/project\n ", want: "/Volumes/collab/project"},
		"at the length limit":            {in: "/" + strings.Repeat("a", collabPathMaxLen-1), want: "/" + strings.Repeat("a", collabPathMaxLen-1)},
		// A tab is the one control character the validator allows through: it
		// is legal in a POSIX directory name and, unlike a newline, cannot
		// break the single-line list item the agent brief renders the path as.
		"embedded tab": {in: "/Volumes/collab/a\tb", want: "/Volumes/collab/a\tb"},

		// Clearing is not an error. A blank field is how the UI says "this
		// entity has no collaboration space", which is the default state.
		"empty":                 {in: "", wantNull: true},
		"whitespace only":       {in: "   ", wantNull: true},
		"whitespace characters": {in: "\t\r\n ", wantNull: true},

		// Relative values are the failure this validator exists for.
		"relative segment":   {in: "work/out", wantErr: "absolute path"},
		"bare filename":      {in: "out.docx", wantErr: "absolute path"},
		"dot relative":       {in: "./work/out", wantErr: "absolute path"},
		"parent relative":    {in: "../work", wantErr: "absolute path"},
		"home shorthand":     {in: "~/协作空间/项目", wantErr: "absolute path"},
		"drive without sep":  {in: "Z:collab", wantErr: "absolute path"},
		"drive letter alone": {in: "Z:", wantErr: "absolute path"},
		// One backslash is a relative Windows path; two are a UNC host.
		"single backslash": {in: `\nas\share`, wantErr: "absolute path"},
		"digit for drive":  {in: "1:/collab", wantErr: "absolute path"},

		// Control characters would break the brief's rendering (a newline turns
		// one list item into two) and are never part of a real directory name.
		"embedded newline":         {in: "/Volumes/collab/a\nb", wantErr: "control characters"},
		"embedded nul":             {in: "/Volumes/collab/a\x00b", wantErr: "control characters"},
		"embedded carriage return": {in: "/Volumes/collab/a\rb", wantErr: "control characters"},
		"embedded escape":          {in: "/Volumes/collab/a\x1bb", wantErr: "control characters"},
		"embedded delete":          {in: "/Volumes/collab/a\x7fb", wantErr: "control characters"},

		"over the length limit": {in: "/" + strings.Repeat("a", collabPathMaxLen), wantErr: "at most 1024"},
		// The limit is measured in BYTES, so a CJK path hits it at roughly a
		// third of the character count the error message names. Pinned because
		// the deployments this feature was built for write CJK paths.
		"cjk over the byte limit": {in: "/" + strings.Repeat("项", 400), wantErr: "at most 1024"},
	}

	for name, tc := range cases {
		name, tc := name, tc
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeCollabPath(tc.in)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("normalizeCollabPath(%q) = %+v, want an error containing %q", tc.in, got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error = %q, want it to contain %q", err, tc.wantErr)
				}
				if got.Valid {
					t.Errorf("a rejected value must not produce a storable column: %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeCollabPath(%q): unexpected error %v", tc.in, err)
			}
			if tc.wantNull {
				if got.Valid {
					t.Fatalf("normalizeCollabPath(%q) = %q, want NULL", tc.in, got.String)
				}
				return
			}
			if !got.Valid || got.String != tc.want {
				t.Fatalf("normalizeCollabPath(%q) = (%q, valid=%v), want %q", tc.in, got.String, got.Valid, tc.want)
			}
		})
	}
}

// storedProjectCollabPath reads the column itself rather than the response, so
// a "the update was rejected" assertion cannot be satisfied by a handler that
// wrote the row and then returned 400.
func storedProjectCollabPath(t *testing.T, projectID string) *string {
	t.Helper()
	var path *string
	dbfx.QueryRow(t, `SELECT collab_path FROM project WHERE id = $1`, projectID).Scan(&path)
	return path
}

// wantCollabPath asserts the response field and the stored column agree on one
// value. They are checked together because either alone hides a real bug: the
// response can echo the request without persisting, and the column can be
// right while projectToResponse drops the field.
func wantCollabPath(t *testing.T, label string, got *string, stored *string, want string) {
	t.Helper()
	if want == "" {
		if got != nil {
			t.Errorf("%s: response collab_path = %q, want null", label, *got)
		}
		if stored != nil {
			t.Errorf("%s: stored collab_path = %q, want NULL", label, *stored)
		}
		return
	}
	if got == nil || *got != want {
		t.Errorf("%s: response collab_path = %v, want %q", label, got, want)
	}
	if stored == nil || *stored != want {
		t.Errorf("%s: stored collab_path = %v, want %q", label, stored, want)
	}
}

// Project collab_path follows the repo's presence semantics, the same contract
// as start_date / due_date: create round-trips the value, an absent key on
// update keeps it, and a present key with null or "" clears it. The clearing
// pair matters because the two clients disagree — a form posts "", a typed
// client posts null — and only one of them being wired up is a field users
// cannot empty.
func TestProjectCollabPathLifecycle(t *testing.T) {
	var created ProjectResponse
	testutil.Call(t, testHandler.CreateProject, newRequest(http.MethodPost,
		"/api/projects?workspace_id="+testWorkspaceID, map[string]any{
			"title": "Collab path project",
			// Pasted with the whitespace a file manager hands over.
			"collab_path": "  " + collabPathExample + "  ",
		})).Want(http.StatusCreated).JSON(&created)
	dbfx.Cleanup(t, `DELETE FROM project WHERE id = $1`, created.ID)
	wantCollabPath(t, "create", created.CollabPath, storedProjectCollabPath(t, created.ID), collabPathExample)

	get := func(label string) ProjectResponse {
		t.Helper()
		var out ProjectResponse
		testutil.Call(t, testHandler.GetProject, withURLParam(
			newRequest(http.MethodGet, "/api/projects/"+created.ID, nil), "id", created.ID)).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	update := func(label string, body map[string]any) ProjectResponse {
		t.Helper()
		var out ProjectResponse
		testutil.Call(t, testHandler.UpdateProject, withURLParam(
			newRequest(http.MethodPut, "/api/projects/"+created.ID, body), "id", created.ID)).
			Want(http.StatusOK).JSON(&out)
		return out
	}

	wantCollabPath(t, "get", get("get").CollabPath, storedProjectCollabPath(t, created.ID), collabPathExample)

	// An absent key keeps the prior value — a client editing the title must not
	// silently unbind the project from its collaboration space.
	renamed := update("absent key", map[string]any{"title": "Collab path project renamed"})
	wantCollabPath(t, "absent key", renamed.CollabPath, storedProjectCollabPath(t, created.ID), collabPathExample)

	const moved = "/Volumes/人机协作空间/AI医药联合创新平台/02模型验证"
	changed := update("new value", map[string]any{"collab_path": moved})
	wantCollabPath(t, "new value", changed.CollabPath, storedProjectCollabPath(t, created.ID), moved)

	cleared := update("explicit null", map[string]any{"collab_path": nil})
	wantCollabPath(t, "explicit null", cleared.CollabPath, storedProjectCollabPath(t, created.ID), "")

	update("restore", map[string]any{"collab_path": collabPathExample})
	emptied := update("empty string", map[string]any{"collab_path": ""})
	wantCollabPath(t, "empty string", emptied.CollabPath, storedProjectCollabPath(t, created.ID), "")

	// A rejected update must leave the row exactly as it was. A relative path
	// that half-applied would be worse than one that was never accepted.
	update("restore", map[string]any{"collab_path": collabPathExample})
	rejected := testutil.Call(t, testHandler.UpdateProject, withURLParam(
		newRequest(http.MethodPut, "/api/projects/"+created.ID, map[string]any{
			"title":       "Renamed by a rejected request",
			"collab_path": "work/out",
		}), "id", created.ID)).Want(http.StatusBadRequest)
	if !strings.Contains(rejected.Text(), "absolute path") {
		t.Errorf("400 body = %q, want it to name the absolute-path rule", rejected.Text())
	}
	after := get("after rejection")
	wantCollabPath(t, "after rejection", after.CollabPath, storedProjectCollabPath(t, created.ID), collabPathExample)
	if after.Title != "Collab path project renamed" {
		t.Errorf("title = %q, want the rejected request to have changed nothing", after.Title)
	}
}

// A create carrying an invalid path is rejected whole: no project row, not a
// project with the field quietly dropped.
func TestCreateProjectInvalidCollabPathCreatesNothing(t *testing.T) {
	const title = "zzcollabreject project"
	w := testutil.Call(t, testHandler.CreateProject, newRequest(http.MethodPost,
		"/api/projects?workspace_id="+testWorkspaceID, map[string]any{
			"title":       title,
			"collab_path": "deliverables/final",
		})).Want(http.StatusBadRequest)
	if !strings.Contains(w.Text(), "absolute path") {
		t.Errorf("400 body = %q, want it to name the absolute-path rule", w.Text())
	}
	dbfx.Cleanup(t, `DELETE FROM project WHERE workspace_id = $1 AND title = $2`, testWorkspaceID, title)
	if n := dbfx.Count(t, `SELECT count(*) FROM project WHERE workspace_id = $1 AND title = $2`, testWorkspaceID, title); n != 0 {
		t.Fatalf("%d project rows created by a rejected request, want 0", n)
	}
}

// The default state, and the one almost every row is in: no key on create
// means NULL, never "". An empty string would render as a bullet pointing at
// nothing in the agent brief and as a bound-but-blank field in the UI.
func TestCreateProjectWithoutCollabPathStoresNull(t *testing.T) {
	var project ProjectResponse
	testutil.Call(t, testHandler.CreateProject, newRequest(http.MethodPost,
		"/api/projects?workspace_id="+testWorkspaceID, map[string]any{
			"title": "No collab path project",
		})).Want(http.StatusCreated).JSON(&project)
	dbfx.Cleanup(t, `DELETE FROM project WHERE id = $1`, project.ID)
	wantCollabPath(t, "project create without the key", project.CollabPath, storedProjectCollabPath(t, project.ID), "")
}

// SearchProjects does not go through sqlc: it builds its column list as a
// string and scans the row positionally into db.Project (project.go, around
// the buildProjectSearchQuery column list and the scan below it). Adding a
// column to one list and not the other shifts every field after it, and the
// shift is silent whenever the neighbouring types happen to be compatible.
//
// project_dates_test.go exists for exactly this reason after start_date /
// due_date; collab_path is the next column to land in that list.
func TestSearchProjectsCarriesCollabPath(t *testing.T) {
	var created ProjectResponse
	testutil.Call(t, testHandler.CreateProject, newRequest(http.MethodPost,
		"/api/projects?workspace_id="+testWorkspaceID, map[string]any{
			"title":       "zzcollabsearch project",
			"description": "searchable collaboration space project",
			"start_date":  "2026-05-01",
			"due_date":    "2026-05-31",
			"collab_path": collabPathExample,
		})).Want(http.StatusCreated).JSON(&created)
	dbfx.Cleanup(t, `DELETE FROM project WHERE id = $1`, created.ID)

	var resp struct {
		Projects []SearchProjectResponse `json:"projects"`
	}
	testutil.Call(t, testHandler.SearchProjects,
		newRequest(http.MethodGet, "/api/projects/search?q=zzcollabsearch", nil)).
		Want(http.StatusOK).JSON(&resp)

	var found *SearchProjectResponse
	for i := range resp.Projects {
		if resp.Projects[i].ID == created.ID {
			found = &resp.Projects[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("created project missing from search results: %+v", resp.Projects)
	}
	if found.CollabPath == nil || *found.CollabPath != collabPathExample {
		t.Errorf("search collab_path = %v, want %q", found.CollabPath, collabPathExample)
	}
	// The neighbours on either side of the new column in the scan list. If
	// collab_path were scanned into the wrong position these would be the
	// fields carrying the damage.
	if found.DueDate == nil || *found.DueDate != "2026-05-31" {
		t.Errorf("search due_date = %v, want 2026-05-31 — column list and scan list disagree", found.DueDate)
	}
	if found.StartDate == nil || *found.StartDate != "2026-05-01" {
		t.Errorf("search start_date = %v, want 2026-05-01", found.StartDate)
	}
	if found.CreatedAt == "" || found.UpdatedAt == "" {
		t.Errorf("search timestamps = (%q, %q), want both populated", found.CreatedAt, found.UpdatedAt)
	}
	if found.Title != "zzcollabsearch project" {
		t.Errorf("search title = %q, want the created title", found.Title)
	}
}
