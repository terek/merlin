package model

import "time"

// LimitReading is what a harness wrote about one of the subscription's usage limits at one moment.
type LimitReading struct {
	At time.Time `json:"at"`
	// Limit is the harness's own name for the limit: Codex limit_id ("codex"), Claude Code
	// rateLimitType ("five_hour"). Empty when the harness did not say.
	Limit string `json:"limit,omitempty"`
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
