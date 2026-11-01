// Package moments finds "moments" in a person's sessions: things they did that say something
// about how they work with coding agents (steering mid-turn, planning first, running a team of
// agents). Each moment belongs to one of three personas, who react to what they see.
//
// Nothing is stored. A report is a pure function of the digests, the clock and the time zone,
// recomputed on every request, so a moment can be added, removed or changed by editing the
// registry (registry.go) and its detector: there is nothing to migrate. A moment's ID is the
// only durable name; consumers ignore ids they do not know.
//
// The design and the catalog are in docs/moments.md.
package moments
