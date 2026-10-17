package localpaths

import (
	"golang.org/x/text/unicode/norm"
	"strings"
	"unicode"
)

func ValidFolder(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 240 || strings.TrimSpace(name) != name {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || strings.ContainsRune("/\\:", r) {
			return false
		}
	}
	return true
}
func Folder(title, suffix string) string {
	s := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("/\\:", r) {
			return '-'
		}
		return r
	}, norm.NFC.String(title))
	r := []rune(strings.Trim(s, " .-"))
	if len(r) > 60 {
		r = r[:60]
	}
	if len(r) == 0 {
		r = []rune("项目")
	}
	return string(r) + "--" + suffix
}
