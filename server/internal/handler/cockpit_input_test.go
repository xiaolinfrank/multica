package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/artifactdownload"
	"github.com/multica-ai/multica/server/internal/service"
	"reflect"
)

func TestCockpitInputHTTPDisabledDoesNotInitializeOrReadBody(t *testing.T) {
	h := &Handler{}
	for _, route := range []http.HandlerFunc{h.CreateCockpitInput, h.UploadCockpitInputBytes, h.GetCockpitRunInputManifest, h.DownloadCockpitInputSignedFile} {
		req := httptest.NewRequest(http.MethodPost, "/", panicInputBody{})
		w := httptest.NewRecorder()
		route(w, req)
		if got, want := w.Code, http.StatusServiceUnavailable; !reflect.DeepEqual(got, want) {
			t.Fatalf("got %#v, want %#v", got, want)
		}
		if !strings.Contains(w.Body.String(), "inputs_unavailable") {
			t.Fatal("missing expected error code")
		}
	}
}

type panicInputBody struct{}

func (panicInputBody) Read([]byte) (int, error) {
	panic("unavailable service must not consume input bytes")
}

func TestCockpitInputHTTPStrictWirePreservesTextAndRejectsIdentityPollution(t *testing.T) {
	const id = "0195fa33-1ea5-7000-8000-000000000001"
	for _, test := range []struct {
		name, body string
		valid      bool
	}{
		{"exact whitespace", `{"command_key":"` + id + `","title":"Inputs","description":"  original\\n text  "}`, true},
		{"actor injection", `{"command_key":"` + id + `","title":"Inputs","description":"","actor_source":"human"}`, false},
		{"missing key", `{"title":"Inputs","description":""}`, false},
		{"null object", `null`, false},
		{"trailing command", `{} {}`, false},
		{"oversize", `{"command_key":"` + id + `","title":"Inputs","description":"` + strings.Repeat("x", 256<<10) + `"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var in service.CockpitInputCreateInput
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			if got, want := decodeCockpitInputBody(w, r, &in), test.valid; !reflect.DeepEqual(got, want) {
				t.Fatalf("got %#v, want %#v", got, want)
			}
			if test.valid {
				if got, want := in.Description, "  original\\n text  "; !reflect.DeepEqual(got, want) {
					t.Fatalf("got %#v, want %#v", got, want)
				}
			} else {
				if got, want := w.Code, 400; !reflect.DeepEqual(got, want) {
					t.Fatalf("got %#v, want %#v", got, want)
				}
			}
		})
	}
	for _, body := range []string{`{"expected_revision":1}`, `{"expected_revision":1,"archived":null}`, `{"expected_revision":-1,"archived":true}`} {
		var in service.CockpitInputArchiveInput
		if decodeCockpitInputBody(httptest.NewRecorder(), httptest.NewRequest("POST", "/", strings.NewReader(body)), &in) {
			t.Fatal("unexpected validation result")
		}
	}
	var archive service.CockpitInputArchiveInput
	if !(decodeCockpitInputBody(httptest.NewRecorder(), httptest.NewRequest("POST", "/", strings.NewReader(`{"expected_revision":1,"archived":false}`)), &archive)) {
		t.Fatal("unexpected validation result")
	}
	var wrong service.CockpitInputVersionSubmitInput
	if decodeCockpitInputBody(httptest.NewRecorder(), httptest.NewRequest("POST", "/", strings.NewReader(`{"command_key":"`+id+`","expected_revision":1,"source":{"kind":"attachment","upload":{"filename":"a","size_bytes":1}}}`)), &wrong) {
		t.Fatal("unexpected validation result")
	}
}

func TestCockpitInputHTTPBoundedQueryRejectsAmbiguousScope(t *testing.T) {
	const id = "0195fa33-1ea5-7000-8000-000000000001"
	for _, query := range []string{"page_size=%zz", "page_size=101", "page_size=0", "page_size=25&page_size=25", "ids=" + id + "&ids=" + id, "project_id=bad", "include_removed=1", "archive=cancelled", "runtime_id=" + id} {
		var q service.CockpitInputQuery
		w := httptest.NewRecorder()
		if parseCockpitInputQuery(w, httptest.NewRequest("GET", "/?"+query, nil), &q, "page_size", "ids", "project_id", "include_removed", "archive") {
			t.Fatal("unexpected validation result")
		}
		if got, want := w.Code, 400; !reflect.DeepEqual(got, want) {
			t.Fatalf("got %#v, want %#v", got, want)
		}
	}
	var q service.CockpitInputQuery
	if !(parseCockpitInputQuery(httptest.NewRecorder(), httptest.NewRequest("GET", "/?ids="+id+"&include_removed=true", nil), &q, "ids", "include_removed")) {
		t.Fatal("unexpected validation result")
	}
	if got, want := q.PageSize, int32(25); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if got, want := q.Scope.Archive, "active"; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if got, want := q.Scope.IDs, []string{id}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if !(q.IncludeRemoved) {
		t.Fatal("unexpected validation result")
	}
}

func TestCockpitInputHTTPTransportDoesNotTrustMachineHeaders(t *testing.T) {
	ws := parseUUID("0195fa33-1ea5-7000-8000-000000000001")
	user := parseUUID("0195fa33-1ea5-7000-8000-000000000002")
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Actor-Source", "task_token")
	r.Header.Set("X-Task-ID", uuidToString(ws))
	r.Header.Set("X-Agent-ID", uuidToString(user))
	_, err := resolveCockpitInputPrincipal(r, ws, user)
	if err == nil {
		t.Fatal("expected rejection")
	}
	r.Header.Set("X-Actor-Source", "daemon_claim")
	_, err = resolveCockpitInputPrincipal(r, ws, user)
	if err == nil {
		t.Fatal("expected rejection")
	}
	r.Header.Set("X-Actor-Source", "cloud_pat")
	p, err := resolveCockpitInputPrincipal(r, ws, user)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := p.ActorSource, "cloud_pat"; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if p.RunID.Valid {
		t.Fatal("unexpected validation result")
	}
}

func TestCockpitInputHTTPCapabilityBindsExactBytesAndPrincipal(t *testing.T) {
	now := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	secret := []byte("test-only-secret")
	c := cockpitInputDownloadClaims{WorkspaceID: "0195fa33-1ea5-7000-8000-000000000001", InputID: "0195fa33-1ea5-7000-8000-000000000002", VersionID: "0195fa33-1ea5-7000-8000-000000000003", OwnerID: "0195fa33-1ea5-7000-8000-000000000004", Hash: strings.Repeat("a", 64), Size: 17, ActorSource: "human", IssuerKind: "human"}
	token, err := mintCockpitInputCapability(secret, c, now)
	if err != nil {
		t.Fatal(err)
	}
	out, q, err := verifyCockpitInputCapability(secret, token, now.Add(59*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := uuidToString(q.VersionID), c.VersionID; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if got, want := uuidToString(q.CredentialOwnerID), c.OwnerID; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if got, want := out.Size, int64(17); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	_, _, err = verifyCockpitInputCapability(secret, token, now.Add(time.Minute))
	if err == nil {
		t.Fatal("expected rejection")
	}
	_, _, err = verifyCockpitInputCapability([]byte("wrong"), token, now)
	if err == nil {
		t.Fatal("expected rejection")
	}
	_, _, err = verifyCockpitInputCapability(secret, token+"x", now)
	if err == nil {
		t.Fatal("expected rejection")
	}

	// A separately signed artifact capability with the same root secret must
	// not authenticate an input download, even for identical IDs and hashes.
	artifactSigner, err := artifactdownload.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	artifactToken, _, err := artifactSigner.Mint(artifactdownload.Claims{WorkspaceID: c.WorkspaceID, ArtifactID: c.InputID, VersionID: c.VersionID, ContentHash: c.Hash, UserID: c.OwnerID}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = verifyCockpitInputCapability(secret, artifactToken, now); err == nil {
		t.Fatal("artifact capability crossed the input signing domain")
	}
	c.ActorSource = "task_token"
	c.IssuerKind = "task_token"
	_, err = mintCockpitInputCapability(secret, c, now)
	if err == nil {
		t.Fatal("expected rejection")
	}
	c.AgentID = c.InputID
	c.RunID = c.VersionID
	c.TaskTokenID = c.WorkspaceID
	token, err = mintCockpitInputCapability(secret, c, now)
	if err != nil {
		t.Fatal(err)
	}
	_, q, err = verifyCockpitInputCapability(secret, token, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := uuidToString(q.RunID), c.RunID; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	c.ActorSource = "cloud_pat"
	_, err = mintCockpitInputCapability(secret, c, now)
	if err == nil {
		t.Fatal("expected rejection")
	}
	c.ActorSource = "daemon_claim"
	c.IssuerKind = "cloud_pat"
	c.TaskTokenID = ""
	c.RuntimeID = c.InputID
	c.DispatchedAt = now.Add(-time.Minute).Format(time.RFC3339Nano)
	token, err = mintCockpitInputCapability(secret, c, now)
	if err != nil {
		t.Fatal(err)
	}
	_, q, err = verifyCockpitInputCapability(secret, token, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := q.TaskID, q.RunID; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
	if !(q.ClaimDispatchedAt.Valid) {
		t.Fatal("unexpected validation result")
	}
	c.IssuerKind = "daemon_token"
	c.DaemonID = "existing-non-uuid-daemon"
	token, err = mintCockpitInputCapability(secret, c, now)
	if err != nil {
		t.Fatal(err)
	}
	_, q, err = verifyCockpitInputCapability(secret, token, now)
	if err != nil || q.TrustedDaemonID != c.DaemonID {
		t.Fatalf("trusted daemon identity did not survive capability: %v %+v", err, q)
	}
	c.IssuerKind = "cloud_pat"
	if _, err = mintCockpitInputCapability(secret, c, now); err == nil {
		t.Fatal("cloud issuer accepted a daemon-token identity")
	}

}
