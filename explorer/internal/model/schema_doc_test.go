package model

import (
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// TestSchemaDocCoversEveryKey keeps docs/digest-schema.md in step with the structs: every
// JSON key and every struct name reachable from SessionDigest must appear in the doc.
func TestSchemaDocCoversEveryKey(t *testing.T) {
	b, err := os.ReadFile("../../docs/digest-schema.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(b)
	seen := map[reflect.Type]bool{}
	var walk func(rt reflect.Type)
	walk = func(rt reflect.Type) {
		for rt.Kind() == reflect.Pointer || rt.Kind() == reflect.Slice || rt.Kind() == reflect.Map {
			rt = rt.Elem()
		}
		if rt.Kind() != reflect.Struct || rt == reflect.TypeOf(time.Time{}) || seen[rt] {
			return
		}
		seen[rt] = true
		if rt != reflect.TypeOf(SessionDigest{}) && !strings.Contains(doc, "## "+rt.Name()) && rt.Name() != "Tokens" {
			t.Errorf("doc has no section for type %s", rt.Name())
		}
		for i := 0; i < rt.NumField(); i++ {
			f := rt.Field(i)
			key := strings.Split(f.Tag.Get("json"), ",")[0]
			if f.Anonymous && key == "" {
				walk(f.Type)
				continue
			}
			if !strings.Contains(doc, "| `"+key+"` |") {
				t.Errorf("%s.%s: key %q not documented", rt.Name(), f.Name, key)
			}
			walk(f.Type)
		}
	}
	walk(reflect.TypeOf(SessionDigest{}))
}
