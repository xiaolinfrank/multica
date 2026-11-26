package migrations

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSQLCSchemaExpansionMatchesNumericMigrationOrder(t *testing.T) {
	base, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if info, e := os.Stat(filepath.Join(base, "sqlc.yaml")); e == nil && !info.IsDir() {
			break
		}
		parent := filepath.Dir(base)
		if parent == base {
			t.Fatal("backend sqlc.yaml not found from package cwd")
		}
		base = parent
	}
	raw, err := os.ReadFile(filepath.Join(base, "sqlc.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		SQL []struct {
			Schema []string `yaml:"schema"`
		} `yaml:"sql"`
	}
	if err = yaml.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.SQL) == 0 {
		t.Fatal("expected at least one backend SQL catalog")
	}
	files, err := filepath.Glob(filepath.Join(base, "migrations", "*.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err = sortMigrationFiles(files, false); err != nil {
		t.Fatal(err)
	}
	expected := make([]string, len(files))
	for i, path := range files {
		expected[i] = filepath.Base(path)
	}
	for i, catalog := range config.SQL {
		var actual []string
		for _, pattern := range catalog.Schema {
			matches, err := filepath.Glob(filepath.Join(base, pattern))
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range matches {
				actual = append(actual, filepath.Base(path))
			}
		}
		if len(actual) == 0 || !reflect.DeepEqual(actual, expected) {
			t.Fatalf("SQLC catalog %d schema order differs from numeric runner: actual=%v expected=%v", i, actual, expected)
		}
	}
}
