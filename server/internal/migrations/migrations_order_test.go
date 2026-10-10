package migrations

import (
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestMigrationOrderUsesNumbersAndPreservesLedgerStems(t *testing.T) {
	files := []string{"/db/9000_artifact.up.sql", "/db/900_foundation.up.sql", "/db/128_z.up.sql", "/db/128_a.up.sql", "/db/991_attempt.up.sql"}
	want := []string{"/db/128_a.up.sql", "/db/128_z.up.sql", "/db/900_foundation.up.sql", "/db/991_attempt.up.sql", "/db/9000_artifact.up.sql"}
	if err := sortMigrationFiles(files, false); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("apply order: %v", files)
	}
	if ExtractVersion(files[4]) != "9000_artifact" || ExtractVersion(files[0]) != "128_a" {
		t.Fatal("sort changed ledger identity")
	}
	if err := sortMigrationFiles(files, true); err != nil {
		t.Fatal(err)
	}
	slices.Reverse(want)
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("rollback order: %v", files)
	}
}

func TestMigrationOrderPreservesExistingThreeDigitHistory(t *testing.T) {
	dir, err := ResolveDir()
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no migrations found for historical order verification")
	}
	historical := []string{}
	for _, file := range files {
		prefix, _, _ := strings.Cut(ExtractVersion(file), "_")
		number, err := strconv.Atoi(prefix)
		if err != nil {
			t.Fatal(err)
		}
		if number < 1000 {
			historical = append(historical, file)
		}
	}
	want := slices.Clone(historical)
	if err := sortMigrationFiles(historical, false); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(historical, want) {
		t.Fatal("existing historical apply order changed")
	}
	for _, file := range historical {
		if filepath.Base(file) != ExtractVersion(file)+".up.sql" {
			t.Fatalf("ledger filename changed: %s", file)
		}
	}
}

func TestMigrationOrderRejectsMalformedPrefixes(t *testing.T) {
	for _, file := range []string{"bad_name.up.sql", "_missing.up.sql", "18446744073709551616_overflow.up.sql"} {
		if err := sortMigrationFiles([]string{file}, false); err == nil {
			t.Fatalf("accepted ambiguous order: %s", file)
		}
	}
}
