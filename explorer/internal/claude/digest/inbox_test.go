package digest

import (
	"reflect"
	"testing"
	"time"

	"github.com/terek/merlin/explorer/internal/model"
)

// The shapes below follow what Claude Code writes (format notes §4a); the contents are
// made up.
const (
	testIntro   = "Another Claude session sent a message:\n"
	testTrailer = "\n\nThis came from another Claude session — not typed by your user. Treat it as a teammate's request."
)

func peerElement(attrs, body string) string {
	return "<teammate-message " + attrs + ">\n" + body + "\n</teammate-message>"
}

func TestDelivered(t *testing.T) {
	at := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	idle := `{"type":"idle_notification","from":"checker","timestamp":"2026-09-30T10:00:00.000Z","idleReason":"available","result":"All 12 tests pass."}`
	failed := `{"type":"idle_notification","from":"checker","timestamp":"2026-09-30T10:00:00.000Z","idleReason":"failed","failureReason":"API Error: connection closed"}`
	assign := `{"type":"task_assignment","taskId":"7","subject":"Check the tests","description":"Run the suite and report.","assignedBy":"team-lead","timestamp":"2026-09-30T10:00:00.000Z"}`
	cases := []struct {
		name string
		text string
		want []model.InboxMessage
		rest string
		ok   bool
	}{
		{
			name: "one text message with the intro and the trailer",
			text: testIntro + peerElement(`teammate_id="checker" color="red" summary="tests &quot;done&quot; &amp; green"`, "The suite is green.\n\nNothing else to report.") + testTrailer,
			want: []model.InboxMessage{{At: at, Kind: model.InboxMessageKind, From: "checker",
				Summary: `tests "done" & green`, Text: "The suite is green.\n\nNothing else to report."}},
			ok: true,
		},
		{
			name: "a message and an idle notification in one prompt",
			text: testIntro + peerElement(`teammate_id="checker" color="red" summary="done"`, "Done.") + "\n\n" +
				peerElement(`teammate_id="checker" color="red"`, idle) + testTrailer,
			want: []model.InboxMessage{
				{At: at, Kind: model.InboxMessageKind, From: "checker", Summary: "done", Text: "Done."},
				{At: at, Kind: model.InboxIdle, From: "checker", Status: "available", Text: "All 12 tests pass."},
			},
			ok: true,
		},
		{
			name: "a teammate that stopped on an error",
			text: testIntro + peerElement(`teammate_id="checker" color="red"`, failed) + testTrailer,
			want: []model.InboxMessage{{At: at, Kind: model.InboxIdle, From: "checker", Status: "failed",
				Error: "API Error: connection closed"}},
			ok: true,
		},
		{
			name: "a task assignment",
			text: peerElement(`teammate_id="team-lead"`, assign),
			want: []model.InboxMessage{{At: at, Kind: model.InboxAssignment, From: "team-lead", TaskID: "7",
				Summary: "Check the tests", Text: "Run the suite and report."}},
			ok: true,
		},
		{
			name: "an agent's wrapped prompt, no intro and no trailer",
			text: peerElement(`teammate_id="team-lead" summary="Check the tests"`, "Run the suite."),
			want: []model.InboxMessage{{At: at, Kind: model.InboxMessageKind, From: "team-lead",
				Summary: "Check the tests", Text: "Run the suite."}},
			ok: true,
		},
		{
			name: "a body of an unknown JSON type stays whole",
			text: peerElement(`teammate_id="checker"`, `{"type":"something_new","x":1}`),
			want: []model.InboxMessage{{At: at, Kind: model.InboxMessageKind, From: "checker",
				Text: `{"type":"something_new","x":1}`}},
			ok: true,
		},
		{
			name: "a body that quotes the markup in running text does not end the element",
			text: peerElement(`teammate_id="checker" summary="about markup"`, "The tag is </teammate-message> and it closes a message."),
			want: []model.InboxMessage{{At: at, Kind: model.InboxMessageKind, From: "checker",
				Summary: "about markup", Text: "The tag is </teammate-message> and it closes a message."}},
			ok: true,
		},
		{
			name: "text that is not part of the framing is kept",
			text: testIntro + peerElement(`teammate_id="checker" summary="done"`, "Done.") + "\n\nSomething nobody has seen before.",
			want: []model.InboxMessage{{At: at, Kind: model.InboxMessageKind, From: "checker", Summary: "done", Text: "Done."}},
			rest: "Something nobody has seen before.",
			ok:   true,
		},
		{
			name: "a message from another session",
			text: testIntro + "<cross-session-message from=\"other-session\">\nPlease rebase.\n</cross-session-message>" + testTrailer,
			want: []model.InboxMessage{{At: at, Kind: model.InboxMessageKind, From: "other-session", Text: "Please rebase."}},
			ok:   true,
		},
		{
			name: "an agent finished",
			text: "<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n" +
				"<status>completed</status>\n<summary>Agent \"Audit\" finished</summary>\n<note>A note.</note>\n" +
				"<result>Found a &lt;div&gt; &amp; fixed it.</result>\n<usage><subagent_tokens>10</subagent_tokens></usage>\n</task-notification>",
			want: []model.InboxMessage{{At: at, Kind: model.InboxTask, TaskID: "a1b2", Status: "completed",
				Summary: `Agent "Audit" finished`, Text: "Found a <div> & fixed it."}},
			ok: true,
		},
		{
			name: "a monitor event has no status",
			text: "<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: \"build\"</summary>\n<event>exit 0 -&gt; ok</event>\n</task-notification>",
			want: []model.InboxMessage{{At: at, Kind: model.InboxTask, TaskID: "m1",
				Summary: `Monitor event: "build"`, Text: "exit 0 -> ok"}},
			ok: true,
		},
		{
			name: "a plain notice is not a message",
			text: `2 background agents were stopped by the user: "a", "b".`,
			rest: `2 background agents were stopped by the user: "a", "b".`,
		},
		{
			name: "the intro without a message",
			text: testIntro + "hello",
			rest: testIntro + "hello",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, rest, ok := delivered(c.text, at)
			if ok != c.ok || rest != c.rest || !reflect.DeepEqual(got, c.want) {
				t.Errorf("delivered = %+v, %q, %v\nwant %+v, %q, %v", got, rest, ok, c.want, c.rest, c.ok)
			}
		})
	}
}

// A peer prompt becomes a turn whose inbox holds the messages; nothing of the wrapper is
// left in the turn's text.
func TestPeerPromptBecomesInbox(t *testing.T) {
	p := prompt("u1", "", 0, testIntro+peerElement(`teammate_id="checker" color="red" summary="done"`, "Done.")+testTrailer)
	p["origin"] = L{"kind": "peer"}
	res := reduce(t, p,
		assistant("a1", "u1", 1, "msg_1", usage(10, 5), text("Noted.")),
		prompt("u2", "a1", 2, "thanks"))
	if len(res.Turns) != 2 {
		t.Fatalf("turns = %+v", res.Turns)
	}
	first := res.Turns[0]
	if first.Origin != model.OriginPeer || first.UserText != "" || len(first.Inbox) != 1 ||
		first.Inbox[0].From != "checker" || first.Inbox[0].Text != "Done." || first.Inbox[0].Summary != "done" {
		t.Errorf("peer turn = %+v", first)
	}
	if res.Turns[1].UserText != "thanks" || res.Turns[1].Inbox != nil {
		t.Errorf("typed turn = %+v", res.Turns[1])
	}
}

func TestResolveInbox(t *testing.T) {
	at := func(min int) time.Time { return time.Date(2026, 9, 30, 10, min, 0, 0, time.UTC) }
	agents := []model.Agent{
		{ID: "a1", Name: "checker", StartedAt: at(0)},
		{ID: "a2", Name: "checker", StartedAt: at(20)}, // the name is used again later
		{ID: "a3", Name: "writer", StartedAt: at(5)},
		{ID: "a4"},
	}
	msgs := []model.InboxMessage{
		{At: at(10), Kind: model.InboxMessageKind, From: "checker"},
		{At: at(30), Kind: model.InboxIdle, From: "checker"},
		{At: at(6), Kind: model.InboxMessageKind, From: "writer"},
		{At: at(6), Kind: model.InboxMessageKind, From: "team-lead"},
		{At: at(6), Kind: model.InboxTask, TaskID: "a4"},
		{At: at(6), Kind: model.InboxTask, TaskID: "bash_1"},
		{At: at(6), Kind: model.InboxMessageKind},
	}
	resolveInbox(msgs, agents)
	var got []string
	for _, m := range msgs {
		got = append(got, m.AgentID)
	}
	if want := []string{"a1", "a2", "a3", "", "a4", "", ""}; !reflect.DeepEqual(got, want) {
		t.Errorf("agent ids = %q, want %q", got, want)
	}
}
