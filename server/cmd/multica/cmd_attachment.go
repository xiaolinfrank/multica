package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var attachmentCmd = &cobra.Command{
	Use:   "attachment",
	Short: "Work with attachments",
}

var attachmentDownloadCmd = &cobra.Command{
	Use:   "download <attachment-id>",
	Short: "Download an attachment to a local file",
	Long:  "Download an attachment by its ID to a local file.",
	Example: `  # Download an image attachment to the current directory
  $ multica attachment download abc123

  # Download to a directory inside the working directory (keep agent
  # downloads out of /tmp and other machine-shared paths, MUL-4252)
  $ multica attachment download abc123 -o ./attachments`,
	Args: exactArgs(1),
	RunE: runAttachmentDownload,
}

var attachmentUploadCmd = &cobra.Command{
	Use:   "upload <path>",
	Short: "Upload a local file as an attachment (onto an issue, or your chat reply)",
	Long: `Upload a local file. The command has two modes.

With --issue, the attachment is linked to that issue so it appears in the
issue's files. Use this when an agent produces an artifact for the issue it is
working on.

Without --issue, the file is tagged with the current chat task and, when the
task completes, the server binds it to the assistant reply it produces — it
appears as an attachment card below your reply even if you paste nothing. The
task id is read from MULTICA_TASK_ID (set by the daemon inside a task);
override it with --task when needed.

Either way the command returns a markdown snippet you may paste on its own line
to place the item: files use !file[name](url) (a card), images use
![name](url) (inline).`,
	Example: `  # Attach a generated plot to a specific issue
  $ multica attachment upload analysis/output/volcano.png --issue MUL-123

  # Attach an image to the current chat reply
  $ multica attachment upload ./chart.png`,
	Args: exactArgs(1),
	RunE: runAttachmentUpload,
}

func init() {
	attachmentCmd.AddCommand(attachmentDownloadCmd)
	attachmentCmd.AddCommand(attachmentUploadCmd)

	attachmentDownloadCmd.Flags().StringP("output-dir", "o", ".", "Directory to save the downloaded file")
	attachmentUploadCmd.Flags().String("issue", "", "Issue ID or reference (e.g. MUL-123) to attach the file to")
	attachmentUploadCmd.Flags().String("task", "", "Chat task id to attach to (defaults to MULTICA_TASK_ID; ignored with --issue)")
}

func runAttachmentUpload(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	path := args[0]
	if isHTTPURL(path) {
		return fmt.Errorf("upload accepts a local file path, not a URL: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read file %s: %w", path, err)
	}
	filename := filepath.Base(path)

	issueRef, _ := cmd.Flags().GetString("issue")
	if issueRef != "" {
		return uploadAttachmentToIssue(cmd, client, data, path, filename, issueRef)
	}

	taskID, _ := cmd.Flags().GetString("task")
	if taskID == "" {
		taskID = client.TaskID
	}
	if taskID == "" {
		return fmt.Errorf("no chat task in context: run inside a chat task (MULTICA_TASK_ID set), pass --task <id>, or attach to an issue with --issue <ref>")
	}

	ctx, cancel := context.WithTimeout(context.Background(), cli.AtLeastAPITimeout(60*time.Second))
	defer cancel()

	att, err := client.UploadChatAttachment(ctx, data, path, taskID)
	if err != nil {
		return fmt.Errorf("upload attachment: %w", err)
	}

	markdown := attachmentMarkdown(filename, att.ContentType, att.MarkdownURL, att.ID)
	fmt.Fprintln(os.Stderr, "Uploaded:", filename)

	return cli.PrintJSON(os.Stdout, map[string]any{
		"id":           att.ID,
		"filename":     filename,
		"markdown_url": att.MarkdownURL,
		"markdown":     markdown,
	})
}

// uploadAttachmentToIssue is the --issue mode: the attachment is linked to an
// issue rather than to a chat task, so it shows up in that issue's files and an
// agent can embed it in a comment. A longer deadline than the chat path because
// agents attach large generated artifacts (plots, reports) here.
func uploadAttachmentToIssue(cmd *cobra.Command, client *cli.APIClient, data []byte, path, filename, issueRef string) error {
	ctx, cancel := context.WithTimeout(cmd.Context(), cli.AtLeastAPITimeout(120*time.Second))
	defer cancel()

	// Resolve the issue ref (e.g. MUL-123) to its canonical UUID — the upload
	// endpoint's issue_id field is UUID-only, but agents know the issue by its
	// human-readable identifier. GET /api/issues/<id> accepts either form.
	var issue map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+issueRef, &issue); err != nil {
		return fmt.Errorf("resolve issue %q: %w", issueRef, err)
	}
	issueUUID := strVal(issue, "id")
	if issueUUID == "" {
		return fmt.Errorf("issue %q has no id", issueRef)
	}

	att, err := client.UploadFileToIssue(ctx, data, filename, issueUUID)
	if err != nil {
		return fmt.Errorf("upload file: %w", err)
	}

	markdown := attachmentMarkdown(att.Filename, att.ContentType, att.MarkdownURL, att.ID)
	fmt.Fprintln(os.Stderr, "Uploaded:", att.Filename, "->", att.ID)
	fmt.Fprintln(os.Stderr, "Paste this markdown into your comment verbatim:")
	fmt.Fprintln(os.Stderr, "  "+markdown)
	return cli.PrintJSON(os.Stdout, map[string]any{
		"id":           att.ID,
		"filename":     att.Filename,
		"markdown_url": att.MarkdownURL,
		"markdown":     markdown,
		"url":          att.URL,
	})
}

// attachmentMarkdown builds the ready-to-paste snippet for an uploaded file.
// Only the canonical /api/attachments/<id>/download URL is resolved by the web
// renderer, so fall back to constructing it when the server omits markdown_url
// rather than letting the caller guess a scheme the UI does not understand.
// Images render inline via ![...](); everything else renders as a block-level
// attachment card via !file[...]().
func attachmentMarkdown(filename, contentType, markdownURL, attachmentID string) string {
	if markdownURL == "" {
		markdownURL = "/api/attachments/" + attachmentID + "/download"
	}
	label := escapeMarkdownLabel(filename)
	if strings.HasPrefix(contentType, "image/") {
		return fmt.Sprintf("![%s](%s)", label, markdownURL)
	}
	return fmt.Sprintf("!file[%s](%s)", label, markdownURL)
}

// escapeMarkdownLabel escapes the metacharacters a markdown link/image label
// may not contain unescaped ([ ] ( ) and backslash), so a filename like
// `report[v2].pdf` stays a single valid label instead of truncating the
// snippet. Kept in sync with the renderers' unescape set
// (packages/ui/markdown/file-cards.ts).
func escapeMarkdownLabel(s string) string {
	return strings.NewReplacer(
		`\`, `\\`,
		`[`, `\[`,
		`]`, `\]`,
		`(`, `\(`,
		`)`, `\)`,
	).Replace(s)
}

func runAttachmentDownload(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), cli.AtLeastAPITimeout(60*time.Second))
	defer cancel()

	// Fetch attachment metadata (includes signed download_url).
	var att map[string]any
	if err := client.GetJSON(ctx, "/api/attachments/"+args[0], &att); err != nil {
		return fmt.Errorf("get attachment: %w", err)
	}

	downloadURL := strVal(att, "download_url")
	if downloadURL == "" {
		return fmt.Errorf("attachment has no download URL")
	}

	filename := filepath.Base(strVal(att, "filename"))
	if filename == "" || filename == "." {
		filename = args[0]
	}

	// Download the file content.
	data, err := client.DownloadFile(ctx, downloadURL)
	if err != nil {
		return fmt.Errorf("download file: %w", err)
	}

	// Write to the output directory, creating it if needed so `-o` works
	// against a directory that does not exist yet (the help example's
	// `-o ./attachments` in a clean workdir).
	outputDir, _ := cmd.Flags().GetString("output-dir")
	if outputDir != "" {
		if err := os.MkdirAll(outputDir, 0o755); err != nil {
			return fmt.Errorf("create output directory: %w", err)
		}
	}
	destPath := filepath.Join(outputDir, filename)

	if err := os.WriteFile(destPath, data, 0o644); err != nil {
		return fmt.Errorf("write file: %w", err)
	}

	// Print the absolute path so agents can reference the file.
	abs, err := filepath.Abs(destPath)
	if err != nil {
		abs = destPath
	}
	fmt.Fprintln(os.Stderr, "Downloaded:", abs)

	// Also print as JSON for --output json compatibility.
	return cli.PrintJSON(os.Stdout, map[string]any{
		"id":       strVal(att, "id"),
		"filename": filename,
		"path":     abs,
		"size":     strVal(att, "size_bytes"),
	})
}
