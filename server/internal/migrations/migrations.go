package migrations

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/selfexec"
)

const maxSearchDepth = 4

var candidateLeaves = []string{
	"migrations",
	filepath.Join("server", "migrations"),
}

// ResolveDir returns the first migrations directory that exists from the
// current working directory.
func ResolveDir() (string, error) {
	seen := make(map[string]bool)
	for _, root := range searchRoots() {
		base := root
		for range maxSearchDepth + 1 {
			for _, leaf := range candidateLeaves {
				dir := filepath.Clean(filepath.Join(base, leaf))
				if seen[dir] {
					continue
				}
				seen[dir] = true
				info, err := os.Stat(dir)
				if err == nil && info.IsDir() {
					// A same-named package directory (internal/migrations) is
					// not the migration directory; only SQL counts.
					sql, gerr := filepath.Glob(filepath.Join(dir, "*.up.sql"))
					if gerr == nil && len(sql) > 0 {
						return dir, nil
					}
				}
			}
			base = filepath.Join(base, "..")
		}
	}
	return "", fmt.Errorf("migrations directory not found")
}

func searchRoots() []string {
	roots := []string{"."}
	if exe, err := selfexec.Resolve(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	return roots
}

// Files returns sorted migration files for the given direction ("up" or
// "down").
func Files(direction string) ([]string, error) {
	dir, err := ResolveDir()
	if err != nil {
		return nil, err
	}

	suffix := "." + direction + ".sql"
	files, err := filepath.Glob(filepath.Join(dir, "*"+suffix))
	if err != nil {
		return nil, err
	}

	if err := sortMigrationFiles(files, direction == "down"); err != nil {
		return nil, err
	}
	return files, nil
}

// The numeric prefix defines execution order; the full filename remains the
// ledger identity and the deterministic tie-break for historical duplicates.
func sortMigrationFiles(files []string, descending bool) error {
	numbers := make(map[string]uint64, len(files))
	for _, file := range files {
		prefix, _, _ := strings.Cut(ExtractVersion(file), "_")
		number, err := strconv.ParseUint(prefix, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid migration numeric prefix in %s: %w", filepath.Base(file), err)
		}
		numbers[file] = number
	}
	sort.Slice(files, func(i, j int) bool {
		left, right := files[i], files[j]
		if descending {
			left, right = right, left
		}
		if numbers[left] != numbers[right] {
			return numbers[left] < numbers[right]
		}
		return filepath.Base(left) < filepath.Base(right)
	})
	return nil
}

// AllVersions returns every "up" migration version found on disk, in apply
// order. The readiness check verifies that all of them are recorded in
// schema_migrations — checking only the lexically-last version would miss an
// out-of-order migration (one numbered below an already-applied later one),
// letting a server report ready while running against a schema that lacks it.
func AllVersions() ([]string, error) {
	files, err := Files("up")
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no up migrations found")
	}
	versions := make([]string, len(files))
	for i, f := range files {
		versions[i] = ExtractVersion(f)
	}
	return versions, nil
}

// ExtractVersion strips the .up.sql / .down.sql suffix from a migration file.
func ExtractVersion(filename string) string {
	base := filepath.Base(filename)
	base = strings.TrimSuffix(base, ".up.sql")
	base = strings.TrimSuffix(base, ".down.sql")
	return base
}
