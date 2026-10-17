package localpaths

import "testing"

func TestFolderContainment(t *testing.T) {
	for _, s := range []string{"", ".", "..", "../x", "x/y", `x\y`, "x:y", "x\n", " x"} {
		if ValidFolder(s) {
			t.Fatalf("accepted %q", s)
		}
	}
	for _, title := range []string{"研发项目", "../escape", "", "x/y", "../.."} {
		if n := Folder(title, "1234abcd"); !ValidFolder(n) {
			t.Fatalf("unsafe generated folder %q", n)
		}
	}
	if Folder("研发项目", "one") == Folder("研发项目", "two") {
		t.Fatal("same-name modules must have distinct folders")
	}
}
