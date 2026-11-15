package digest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const limitsMain = `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-09-18T20:30:00.000Z","sessionId":"S","cwd":"/home/dev/acme","version":"2.1.277","message":{"role":"user","content":"Go."}}
{"type":"assistant","uuid":"e1","parentUuid":"u1","timestamp":"2026-09-18T20:34:13.022Z","sessionId":"S","isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"quotaLimits":{"status":"rejected","resetsAt":1789774200,"rateLimitType":"five_hour","overageStatus":"rejected"},"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You have hit a limit."}]}}
{"type":"assistant","uuid":"e2","parentUuid":"e1","timestamp":"2026-09-18T20:35:00.000Z","sessionId":"S","isApiErrorMessage":true,"error":"invalid_request","apiErrorStatus":400,"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Bad request."}]}}
{"type":"assistant","uuid":"e3","parentUuid":"e2","timestamp":"2026-09-18T20:36:00.000Z","sessionId":"S","session_id":"OTHER","isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"quotaLimits":{"status":"rejected","resetsAt":1789774200,"rateLimitType":"five_hour"},"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"copied"}]}}
{"type":"assistant","uuid":"e4","parentUuid":"e3","timestamp":"2026-09-18T20:37:00.000Z","sessionId":"S","forkedFrom":{"sessionId":"OTHER","messageUuid":"m9"},"isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"quotaLimits":{"status":"rejected","resetsAt":1789774200,"rateLimitType":"five_hour"},"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"copied by a fork"}]}}
`

const limitsAgent = `{"type":"assistant","uuid":"e1","timestamp":"2026-09-18T20:34:13.022Z","sessionId":"S","agentId":"ag1","isSidechain":true,"isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"quotaLimits":{"status":"rejected","resetsAt":1789774200,"rateLimitType":"five_hour"},"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"a copy of the parent's record"}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-09-20T08:00:00.000Z","sessionId":"S","agentId":"ag1","isSidechain":true,"isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,"quotaLimits":{"status":"rejected","resetsAt":1790300000,"rateLimitType":"seven_day_opus"},"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You have hit a limit."}]}}
`

func TestRejectedQuotaLimits(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(strings.TrimSpace(body)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	main := buildFile(t, write("main.jsonl", limitsMain))
	if len(main.Limits) != 1 {
		t.Fatalf("main limits = %+v (a non-limit error and a copied record give none)", main.Limits)
	}
	ag := buildFile(t, write("agent.jsonl", limitsAgent))
	asm := Assemble(main, []AgentFile{{ID: "ag1", Result: ag}})
	if len(asm.Limits) != 2 {
		t.Fatalf("limits = %+v", asm.Limits)
	}
	a, b := asm.Limits[0], asm.Limits[1]
	if !a.Rejected || a.Limit != "five_hour" || a.WindowMinutes != 300 || a.AgentID != "" || a.UsedPercent != nil ||
		!a.At.Equal(time.Date(2026, 9, 18, 20, 34, 13, 22000000, time.UTC)) || a.ResetsAt.Unix() != 1789774200 || a.ResetsAt.Location() != time.UTC {
		t.Errorf("main reading = %+v", a)
	}
	if !b.Rejected || b.Limit != "seven_day_opus" || b.WindowMinutes != 10080 || b.AgentID != "ag1" {
		t.Errorf("agent reading = %+v", b)
	}
}
