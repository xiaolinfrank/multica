package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestBuiltinManifestExportNeedsNoServerConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "not-a-database")
	t.Setenv("JWT_SECRET", "")
	var out bytes.Buffer
	handled, err := exportBuiltinSkills([]string{"--builtin-skills-manifest"}, &out, strings.Repeat("a", 40))
	if !handled || err != nil {
		t.Fatalf("offline export: %v %v", handled, err)
	}
	var data struct {
		Commit string `json:"commit"`
		Skills []any  `json:"skills"`
	}
	if err := json.Unmarshal(out.Bytes(), &data); err != nil || len(data.Skills) != 3 || data.Commit != strings.Repeat("a", 40) {
		t.Fatalf("unexpected artifact: %s %v", out.String(), err)
	}
	if handled, err := exportBuiltinSkills([]string{"--builtin-skills-manifest", "extra"}, &out, "dev"); !handled || err == nil {
		t.Fatal("extra arguments accepted")
	}
	if handled, err := exportBuiltinSkills(nil, &out, "dev"); handled || err != nil {
		t.Fatal("normal server boot intercepted")
	}
}
