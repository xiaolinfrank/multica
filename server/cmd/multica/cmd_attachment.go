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

  # Download to a specific directory
  $ multica attachment download abc123 -o /tmp/images`,
	Args: exactArgs(1),
	RunE: runAttachmentDownload,
}

var attachmentUploadCmd = &cobra.Command{
	Use:   "upload <file>",
	Short: "Upload a local file as an attachment, optionally onto an issue",
	Long: "Upload a local file to the workspace. With --issue, the attachment " +
		"is linked to that issue so it appears in the issue's files. The printed " +
		"markdown_url can be embedded in a comment (e.g. ![plot](<markdown_url>)) " +
		"to render the file inline.",
	Example: `  # Attach a generated plot to the current issue
  $ multica attachment upload analysis/output/volcano.png --issue MUL-123`,
	Args: exactArgs(1),
	RunE: runAttachmentUpload,
}

func init() {
	attachmentCmd.AddCommand(attachmentDownloadCmd)
	attachmentCmd.AddCommand(attachmentUploadCmd)

	attachmentDownloadCmd.Flags().StringP("output-dir", "o", ".", "Directory to save the downloaded file")
	attachmentUploadCmd.Flags().String("issue", "", "Issue ID or reference (e.g. MUL-123) to attach the file to")
}

func runAttachmentUpload(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	filePath := args[0]
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read file: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), cli.AtLeastAPITimeout(120*time.Second))
	defer cancel()

	// Resolve the issue ref (e.g. MUL-123) to its canonical UUID — the upload
	// endpoint's issue_id field is UUID-only, but agents know the issue by its
	// human-readable identifier. GET /api/issues/<id> accepts either form.
	issueUUID := ""
	if ref, _ := cmd.Flags().GetString("issue"); ref != "" {
		var issue map[string]any
		if err := client.GetJSON(ctx, "/api/issues/"+ref, &issue); err != nil {
			return fmt.Errorf("resolve issue %q: %w", ref, err)
		}
		issueUUID = strVal(issue, "id")
		if issueUUID == "" {
			return fmt.Errorf("issue %q has no id", ref)
		}
	}

	att, err := client.UploadFileToIssue(ctx, data, filepath.Base(filePath), issueUUID)
	if err != nil {
		return fmt.Errorf("upload file: %w", err)
	}

	// Build a ready-to-paste markdown snippet. Only the canonical
	// `/api/attachments/<id>/download` URL is resolved by the web renderer
	// (it matches the attachment by the id in this path) — so we hand the
	// caller the exact, correct markdown rather than letting them guess a
	// scheme like `attachment://name`, which the UI does not understand.
	mdURL := att.MarkdownURL
	if mdURL == "" {
		mdURL = "/api/attachments/" + att.ID + "/download"
	}
	ext := strings.ToLower(filepath.Ext(att.Filename))
	isImage := ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" || ext == ".svg"
	snippet := "[" + att.Filename + "](" + mdURL + ")"
	if isImage {
		snippet = "!" + snippet
	}

	fmt.Fprintln(os.Stderr, "Uploaded:", att.Filename, "->", att.ID)
	fmt.Fprintln(os.Stderr, "Paste this markdown into your comment verbatim:")
	fmt.Fprintln(os.Stderr, "  "+snippet)
	return cli.PrintJSON(os.Stdout, map[string]any{
		"id":           att.ID,
		"filename":     att.Filename,
		"markdown_url": mdURL,
		"markdown":     snippet,
		"url":          att.URL,
	})
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

	// Write to the output directory.
	outputDir, _ := cmd.Flags().GetString("output-dir")
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
