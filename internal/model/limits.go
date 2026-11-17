package model

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

// LimitReading is what a harness wrote about one of the subscription's usage limits at one moment.
type LimitReading struct {
	At time.Time `json:"at"`
	// Limit is the harness's own name for the limit: Codex limit_id ("codex"), Claude Code
	// rateLimitType ("five_hour"). Empty when the harness did not say.
	Limit string `json:"limit,omitempty"`
	// Kind is a normalized classification when the harness supplies enough evidence.
	Kind    string `json:"kind,omitempty"`
	Account string `json:"account,omitempty"`
	// AccountKnown marks an explicit account override, including an unknown account.
	AccountKnown bool `json:"accountKnown,omitempty"`
	// WindowMinutes is the window's length: Codex window_minutes; Claude five_hour 300,
	// seven_day* 10080; 0 when not known.
	WindowMinutes int `json:"windowMinutes,omitempty"`
	// UsedPercent is the share of the window used, 0-100; nil when the harness did not record
	// it (always nil for Claude Code).
	UsedPercent *float64  `json:"usedPercent,omitempty"`
	ResetsAt    time.Time `json:"resetsAt,omitzero"` // UTC
	Plan        string    `json:"plan,omitempty"`    // Codex plan_type
	// Rejected: the harness refused a call at At because this limit was reached.
	Rejected bool   `json:"rejected,omitempty"`
	AgentID  string `json:"agentId,omitempty"` // empty = main agent / main thread
}

// AccountKey makes an opaque key from the harness's account identifiers.
func AccountKey(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		h.Write([]byte(strconv.Itoa(len(part))))
		h.Write([]byte{':'})
		h.Write([]byte(part))
	}
	return hex.EncodeToString(h.Sum(nil))
}
