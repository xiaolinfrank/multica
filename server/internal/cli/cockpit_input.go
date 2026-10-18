package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
)

// Input commands never follow a redirect or retry an ambiguous response. The
// caller retains the original command key and queries its exact receipt.
func (c *APIClient) CockpitInputJSON(ctx context.Context, method, path string, body any, out any) error {
	parsed, err := url.Parse(path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Fragment != "" || !strings.HasPrefix(parsed.Path, "/api/") {
		return fmt.Errorf("input requests require a relative API path")
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		if len(data) > 256<<10 {
			return fmt.Errorf("input command exceeds 256 KiB")
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setHeaders(req)
	// Disable replayable body even for a complete in-memory command: recovery
	// belongs to its application receipt, not an implicit transport resend.
	req.GetBody = nil
	client := *c.HTTPClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err = wrapTransport(req, err); err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return newHTTPError(method, path, response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil {
		return wrapBodyRead(req, err)
	}
	if len(data) > 4<<20 {
		return fmt.Errorf("input response exceeds its metadata budget")
	}
	if out == nil {
		return nil
	}
	return wrapBodyRead(req, json.Unmarshal(data, out))
}

// UploadCockpitInputBytes streams a complete local file into one exact server
// session. A failed response never means it is safe to resend these bytes.
func (c *APIClient) UploadCockpitInputBytes(ctx context.Context, inputID, versionID, transferID string, revision, size int64, source io.Reader, out any) error {
	ids := []string{inputID, versionID, transferID}
	for _, id := range ids {
		if parsed, err := util.ParseUUID(id); err != nil || !parsed.Valid {
			return fmt.Errorf("input upload requires exact UUID identities")
		}
	}
	if revision < 1 || size < 0 || size > 500<<20 || source == nil {
		return fmt.Errorf("input upload requires a positive observed revision and 0-500 MiB size")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	path := "/api/cockpit/inputs/" + url.PathEscape(inputID) + "/versions/" + url.PathEscape(versionID) + "/transfers/" + url.PathEscape(transferID) + "/bytes"
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.BaseURL+path, io.LimitReader(source, size+1))
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.GetBody = nil
	if size == 0 {
		req.Body = http.NoBody
	}
	c.setHeaders(req)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Input-Transfer-Revision", strconv.FormatInt(revision, 10))
	client := *c.HTTPClient
	client.Timeout = 8 * time.Minute
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err = wrapTransport(req, err); err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return newHTTPError(http.MethodPut, path, response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil {
		return wrapBodyRead(req, err)
	}
	if len(data) > 64<<10 {
		return fmt.Errorf("input upload response exceeds its receipt budget")
	}
	if out == nil {
		return nil
	}
	return wrapBodyRead(req, json.Unmarshal(data, out))
}
