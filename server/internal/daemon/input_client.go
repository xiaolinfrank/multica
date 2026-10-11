package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type fixedInputManifestMetadata struct {
	WorkspaceID   string `json:"workspace_id"`
	IssueID       string `json:"issue_id"`
	ID            string `json:"id"`
	ManifestHash  string `json:"manifest_hash"`
	ItemTotal     int64  `json:"item_total"`
	RequiredTotal int64  `json:"required_total"`
}
type fixedRunInputManifest struct {
	WorkspaceID      string                      `json:"workspace_id"`
	TaskID           string                      `json:"task_id"`
	IssueID          string                      `json:"issue_id"`
	ManifestVersion  *fixedInputManifestMetadata `json:"manifest_version"`
	PreparationState string                      `json:"preparation_state"`
	PreparationHash  *string                     `json:"preparation_hash"`
	RuntimeSupported bool                        `json:"runtime_supported"`
}
type fixedInputManifestItem struct {
	Position           int    `json:"position"`
	InputID            string `json:"input_id"`
	InputTitle         string `json:"input_title"`
	InputVersionID     string `json:"input_version_id"`
	InputVersionNumber int    `json:"input_version_number"`
	PayloadKind        string `json:"payload_kind"`
	Filename           string `json:"filename"`
	ContentType        string `json:"content_type"`
	SizeBytes          int64  `json:"size_bytes"`
	ContentHash        string `json:"content_hash"`
	Purpose            string `json:"purpose"`
	Required           bool   `json:"required"`
}
type fixedInputManifestPage struct {
	WorkspaceID       string                   `json:"workspace_id"`
	IssueID           string                   `json:"issue_id"`
	ManifestVersionID string                   `json:"manifest_version_id"`
	ManifestHash      string                   `json:"manifest_hash"`
	PageSize          int                      `json:"page_size"`
	Items             []fixedInputManifestItem `json:"items"`
	Total             int64                    `json:"total"`
	NextCursor        *string                  `json:"next_cursor"`
}
type fixedInputDownloadLink struct {
	WorkspaceID string `json:"workspace_id"`
	InputID     string `json:"input_id"`
	VersionID   string `json:"version_id"`
	ContentHash string `json:"content_hash"`
	SizeBytes   int64  `json:"size_bytes"`
	URL         string `json:"url"`
	ExpiresAt   string `json:"expires_at"`
}

func inputClaimQuery(task Task) url.Values {
	return url.Values{"task_id": {task.ID}, "runtime_id": {task.RuntimeID}, "dispatched_at": {task.DispatchedAt}}
}

// All control reads are exact dispatched claims. Headers carry the daemon's
// own credential, never a fabricated actor or task identity header.
func (c *Client) fixedInputJSON(ctx context.Context, task Task, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		if len(data) > 64<<10 {
			return fmt.Errorf("fixed input command exceeds its budget")
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.GetBody = nil
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Workspace-ID", task.WorkspaceID)
	req.Header.Set("Content-Type", "application/json")
	c.setIdentityHeaders(req)
	client := *c.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &requestError{Method: method, Path: path, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(data))}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (512<<10)+1))
	if err != nil {
		return err
	}
	if len(data) > 512<<10 {
		return fmt.Errorf("%w: fixed input metadata exceeds its budget", errInvalidResponseBody)
	}
	if err = json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%w: fixed input metadata", errInvalidResponseBody)
	}
	return nil
}
func (c *Client) readFixedRunInputs(ctx context.Context, task Task) (fixedRunInputManifest, error) {
	var out fixedRunInputManifest
	q := url.Values{"runtime_id": {task.RuntimeID}, "dispatched_at": {task.DispatchedAt}}
	err := c.fixedInputJSON(ctx, task, http.MethodGet, "/api/tasks/"+url.PathEscape(task.ID)+"/input-manifest?"+q.Encode(), nil, &out)
	return out, err
}
func (c *Client) readFixedInputPage(ctx context.Context, task Task, cursor string) (fixedInputManifestPage, error) {
	var out fixedInputManifestPage
	q := inputClaimQuery(task)
	q.Set("page_size", "100")
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	path := "/api/cockpit/issues/" + url.PathEscape(task.IssueID) + "/input-manifest/versions/" + url.PathEscape(task.InputManifestVersionID) + "/items?" + q.Encode()
	err := c.fixedInputJSON(ctx, task, http.MethodGet, path, nil, &out)
	return out, err
}
func (c *Client) recordFixedInputPreparation(ctx context.Context, task Task, state string, prepared []string, code string) (fixedRunInputManifest, error) {
	if prepared == nil {
		prepared = []string{}
	}
	var out fixedRunInputManifest
	body := map[string]any{"manifest_version_id": task.InputManifestVersionID, "manifest_hash": task.InputManifestHash, "dispatched_at": task.DispatchedAt, "state": state, "prepared_input_version_ids": prepared, "error_code": code}
	q := url.Values{"runtime_id": {task.RuntimeID}}
	err := c.fixedInputJSON(ctx, task, http.MethodPost, "/api/tasks/"+url.PathEscape(task.ID)+"/input-preparation?"+q.Encode(), body, &out)
	return out, err
}
func (c *Client) fixedInputLink(ctx context.Context, task Task, item fixedInputManifestItem) (fixedInputDownloadLink, error) {
	var out fixedInputDownloadLink
	path := "/api/cockpit/inputs/" + url.PathEscape(item.InputID) + "/versions/" + url.PathEscape(item.InputVersionID) + "/download-link?" + inputClaimQuery(task).Encode()
	err := c.fixedInputJSON(ctx, task, http.MethodPost, path, nil, &out)
	return out, err
}
func fixedInputDownloadPath(raw, version string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Fragment != "" || parsed.Path != "/api/cockpit/input-files/"+version+"/download" || strings.ContainsAny(raw, "\\\r\n\t ") {
		return false
	}
	q, err := url.ParseQuery(parsed.RawQuery)
	return err == nil && len(q) == 1 && len(q["token"]) == 1 && q.Get("token") != ""
}

// Signed reads send no daemon token and never follow a redirect. Error text
// deliberately omits the signed URL and response body.
func (c *Client) openFixedInputBytes(ctx context.Context, path string) (io.ReadCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, fmt.Errorf("invalid fixed input download destination")
	}
	client := *c.bundleClient
	client.Timeout = 8 * time.Minute
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("fixed input download transport failed")
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		return nil, &requestError{Method: http.MethodGet, Path: "/api/cockpit/input-files/:version/download", StatusCode: response.StatusCode, Body: "fixed input download refused"}
	}
	return response.Body, nil
}
