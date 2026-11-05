package workspacecontext

import "testing"

func TestForCreatePreservesUserContext(t *testing.T) {
	for _, raw := range []string{"", " \t\r\n", "\u3000"} {
		if got := ForCreate(&raw); got != V1 {
			t.Fatalf("blank context %q did not receive the default", raw)
		}
	}
	if ForCreate(nil) != V1 {
		t.Fatal("omitted context did not receive the default")
	}
	custom := "  User instructions\nKeep this whitespace.  "
	if got := ForCreate(&custom); got != custom {
		t.Fatal("user context was changed")
	}
}
