package main

import "testing"

func TestStarProxyBackendBind(t *testing.T) {
	for _, c := range []struct{ host, want string }{{"", ":18204"}, {"127.0.0.1", "127.0.0.1:18204"}, {"::1", "[::1]:18204"}} {
		t.Setenv("MULTICA_BIND_HOST", c.host)
		if got := mainHTTPAddress("18204"); got != c.want {
			t.Fatalf("unexpected listener %s", got)
		}
	}
}
