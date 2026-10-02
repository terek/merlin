package transcript

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Content is a message's content, which is a JSON string or an array of blocks. A string
// is normalised to a single text block, with FromString set.
type Content struct {
	Blocks     []Block
	FromString bool
}

// UnmarshalJSON accepts a string, an array of blocks, or anything else (left empty).
func (c *Content) UnmarshalJSON(b []byte) error {
	*c = Content{}
	var s string
	if json.Unmarshal(b, &s) == nil {
		c.FromString = true
		c.Blocks = []Block{{Type: "text", Text: s}}
		return nil
	}
	var blocks []Block
	if json.Unmarshal(b, &blocks) == nil {
		c.Blocks = blocks
	}
	return nil
}

// MarshalJSON writes the content back in the form it was read.
func (c Content) MarshalJSON() ([]byte, error) {
	if c.FromString {
		if len(c.Blocks) == 0 {
			return json.Marshal("")
		}
		return json.Marshal(c.Blocks[0].Text)
	}
	if c.Blocks == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(c.Blocks)
}

// Text joins the text blocks with a newline. Tool calls, tool results, thinking and
// images are not text.
func (c Content) Text() string {
	var parts []string
	for _, b := range c.Blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// HasToolResult reports whether any block is a tool_result.
func (c Content) HasToolResult() bool {
	for _, b := range c.Blocks {
		if b.Type == "tool_result" {
			return true
		}
	}
	return false
}

// ImageCount is the number of image blocks.
func (c Content) ImageCount() int {
	n := 0
	for _, b := range c.Blocks {
		if b.Type == "image" {
			n++
		}
	}
	return n
}

// Block is one content block. Which fields are set depends on Type: "text" (Text),
// "thinking" (Thinking), "tool_use" (ID, Name, Input), "tool_result" (ToolUseID,
// Content, IsError), "image" (nothing kept). Unknown block types decode with Type only.
type Block struct {
	Type string `json:"type"`

	Text     string `json:"text,omitempty"`
	Thinking string `json:"thinking,omitempty"`

	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`

	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"` // tool_result: string or array
	IsError   bool            `json:"is_error,omitempty"`
}

// UnmarshalJSON decodes a block, ignoring fields of unexpected type.
func (b *Block) UnmarshalJSON(data []byte) error {
	type plain Block
	var p plain
	if err := unmarshalTolerant(data, &p); err != nil {
		*b = Block{}
		return nil // not an object: an empty block rather than a failed record
	}
	*b = Block(p)
	return nil
}

// ResultText returns the text of a tool_result block whose content is a string or an
// array of text blocks.
func (b Block) ResultText() string {
	var c Content
	if len(b.Content) > 0 {
		_ = c.UnmarshalJSON(b.Content)
	}
	return c.Text()
}

// AgentInput is the input of an Agent (formerly Task) tool call.
type AgentInput struct {
	Description     string `json:"description"`
	Prompt          string `json:"prompt"`
	SubagentType    string `json:"subagent_type"`
	Model           string `json:"model"`
	Name            string `json:"name"`
	RunInBackground bool   `json:"run_in_background"`
	Isolation       string `json:"isolation"`
}

// IsAgentSpawn reports whether the block is a tool_use of the agent-spawning tool.
// "Task" is the older name of the tool (assumed, not verified).
func (b Block) IsAgentSpawn() bool {
	return b.Type == "tool_use" && (b.Name == "Agent" || b.Name == "Task")
}

// AgentInput decodes the input of an agent-spawning tool_use block.
func (b Block) AgentInput() (AgentInput, bool) {
	var in AgentInput
	if !b.IsAgentSpawn() || unmarshalTolerant(b.Input, &in) != nil {
		return AgentInput{}, false
	}
	return in, true
}

// CacheCreation is usage.cache_creation: cache writes split by lifetime.
type CacheCreation struct {
	Ephemeral5mInputTokens int64 `json:"ephemeral_5m_input_tokens"`
	Ephemeral1hInputTokens int64 `json:"ephemeral_1h_input_tokens"`
}

// ServerToolUse is usage.server_tool_use.
type ServerToolUse struct {
	WebSearchRequests int64 `json:"web_search_requests"`
	WebFetchRequests  int64 `json:"web_fetch_requests"`
}

// Usage is an API usage object. Absent numbers are zero.
type Usage struct {
	InputTokens              int64          `json:"input_tokens"`
	OutputTokens             int64          `json:"output_tokens"`
	CacheReadInputTokens     int64          `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64          `json:"cache_creation_input_tokens"`
	CacheCreation            *CacheCreation `json:"cache_creation,omitempty"`
	ServerToolUse            *ServerToolUse `json:"server_tool_use,omitempty"`
	Speed                    string         `json:"speed,omitempty"` // "standard" | "fast"
	ServiceTier              string         `json:"service_tier,omitempty"`
}

// ContextTokens is the context size at this message: input + cache read + cache write.
func (u Usage) ContextTokens() int64 {
	return u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
}

// CacheWrites returns cache-write tokens by lifetime. The two always add up to
// cache_creation_input_tokens, which is what is billed: the 1-hour part is the breakdown
// figure (capped at the total) and the 5-minute part is the remainder. When the breakdown
// is absent the whole total is taken as 5-minute writes.
func (u Usage) CacheWrites() (w5m, w1h int64) {
	total := max(u.CacheCreationInputTokens, 0)
	if u.CacheCreation != nil {
		w1h = min(max(u.CacheCreation.Ephemeral1hInputTokens, 0), total)
	}
	return total - w1h, w1h
}

// AssistantMessage is the API message inside an assistant record. One API response is
// written as several records sharing ID; the caller groups them.
type AssistantMessage struct {
	ID         string  `json:"id"`
	Model      string  `json:"model"` // "<synthetic>" for locally generated messages
	Role       string  `json:"role,omitempty"`
	Content    Content `json:"content"`
	StopReason string  `json:"stop_reason,omitempty"` // null on non-final lines
	Usage      Usage   `json:"usage"`
}

// UserMessage is the message inside a user record.
type UserMessage struct {
	Role    string  `json:"role,omitempty"`
	Content Content `json:"content"`
}

// AssistantMessage decodes the message of an assistant record.
func (r *Record) AssistantMessage() (*AssistantMessage, bool) {
	if r.Type != TypeAssistant || len(r.Message) == 0 {
		return nil, false
	}
	var m AssistantMessage
	if unmarshalTolerant(r.Message, &m) != nil {
		return nil, false
	}
	return &m, true
}

// UserMessage decodes the message of a user record.
func (r *Record) UserMessage() (*UserMessage, bool) {
	if r.Type != TypeUser || len(r.Message) == 0 {
		return nil, false
	}
	var m UserMessage
	if unmarshalTolerant(r.Message, &m) != nil {
		return nil, false
	}
	return &m, true
}

// ToolUseResult is the envelope's toolUseResult for an agent spawn. Fields not relevant
// to the status stay zero.
type ToolUseResult struct {
	// Status is "completed", "async_launched" or "teammate_spawned".
	Status string `json:"status"`

	AgentID string `json:"agentId"` // completed, async_launched

	// completed
	Content           json.RawMessage `json:"content,omitempty"`
	TotalTokens       int64           `json:"totalTokens"`
	TotalDurationMs   int64           `json:"totalDurationMs"`
	TotalToolUseCount int64           `json:"totalToolUseCount"`
	Usage             *Usage          `json:"usage,omitempty"`

	// async_launched
	Description   string `json:"description"`
	ResolvedModel string `json:"resolvedModel"`
	OutputFile    string `json:"outputFile"`

	// teammate_spawned
	Name       string `json:"name"`
	TeamName   string `json:"team_name"`
	TeammateID string `json:"agent_id"` // "<name>@<team>"
	Model      string `json:"model"`
}

// Spawn statuses.
const (
	SpawnCompleted       = "completed"
	SpawnAsyncLaunched   = "async_launched"
	SpawnTeammateSpawned = "teammate_spawned"
)

// ToolUseResult decodes toolUseResult when it is an object with a status. It returns
// false when the field is absent, a string, or an object without a status.
func (r *Record) ToolUseResult() (*ToolUseResult, bool) {
	raw := bytes.TrimSpace(r.RawToolUseResult)
	if len(raw) == 0 || raw[0] != '{' {
		return nil, false
	}
	var t ToolUseResult
	if unmarshalTolerant(raw, &t) != nil || t.Status == "" {
		return nil, false
	}
	return &t, true
}
