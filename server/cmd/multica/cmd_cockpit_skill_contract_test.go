package main

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCockpitSkillExamplesResolveToRegisteredCommands(t *testing.T) {
	root := filepath.Join("..", "..", "internal", "service", "builtin_skills", "multica-cockpit")
	examples := 0
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(name) != ".md" {
			return err
		}
		file, err := os.Open(name)
		if err != nil {
			return err
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		line := 0
		for scanner.Scan() {
			line++
			text := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(text, "multica cockpit ") {
				continue
			}
			examples++
			words := strings.Fields(text)[2:]
			cmd, _, err := cockpitCmd.Find(words)
			if err != nil || cmd == nil || cmd.RunE == nil && cmd.Run == nil {
				t.Errorf("%s:%d documents an unavailable command: %s (error=%v)", name, line, text, err)
			}
		}
		return scanner.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if examples < 30 {
		t.Fatalf("only %d command examples checked; skill coverage disappeared", examples)
	}
}

func TestCockpitCommandTreeKeepsCurrentMeetingOperationsAndRetiresTemplateFlows(t *testing.T) {
	for _, path := range []string{
		"meeting issue list", "meeting issue link", "meeting issue roles", "meeting issue unlink",
		"meeting node list", "meeting node link", "meeting node unlink", "node next-code",
		"change list", "change propose", "change preview", "change withdraw",
		"meeting workflow summary", "meeting workflow submit", "meeting directory show",
	} {
		cmd, _, err := cockpitCmd.Find(strings.Fields(path))
		if err != nil || cmd == nil || cmd.RunE == nil {
			t.Errorf("missing current cockpit command %q: %v", path, err)
		}
	}
	for _, path := range []string{"meeting agenda", "meeting template"} {
		cmd, _, _ := cockpitCmd.Find(strings.Fields(path))
		if cmd != nil && cmd.RunE != nil {
			t.Errorf("retired command still executable: %q", path)
		}
	}
}
