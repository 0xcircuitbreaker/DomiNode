package dominusnode

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestConfigRedactsTokens(t *testing.T) {
	const at = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.access-sig"
	const rt = "refresh-token-secret-value"
	c := Config{BaseURL: "https://api.example.com", AccessToken: at, RefreshToken: rt}
	outs := []string{
		c.String(), c.GoString(),
		fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c), fmt.Sprintf("%s", c), fmt.Sprintf("%q", c),
		fmt.Sprintf("%v", &c), fmt.Sprintf("%+v", &c), fmt.Sprint(c), fmt.Sprintln(c),
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	outs = append(outs, string(b))
	for _, o := range outs {
		if strings.Contains(o, at) || strings.Contains(o, rt) || strings.Contains(o, "access-sig") {
			t.Fatalf("token leaked: %s", o)
		}
		if !strings.Contains(o, redacted) {
			t.Fatalf("missing redaction marker: %s", o)
		}
	}
	if !strings.Contains(fmt.Sprintf("%v", c), "https://api.example.com") {
		t.Fatal("non-secret fields should still print")
	}
	if c.AccessToken != at || c.RefreshToken != rt {
		t.Fatal("redaction must not modify the fields")
	}
}
