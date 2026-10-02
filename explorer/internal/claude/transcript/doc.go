// Package transcript parses Claude Code transcript JSONL files into typed records.
//
// It holds the tolerant record structs and stateless classification helpers described in
// docs/transcript-format.md. It does not read files, price anything or build digests.
//
// Tolerance rules: Decode fails only when a line is not a JSON object. Unknown fields are
// ignored, a field of an unexpected JSON type is left at its zero value (the rest of the
// record still decodes), and a record of an unknown type yields a Record with only Type
// and Raw set. Everything beyond the envelope is decoded lazily from Record.Raw by the
// accessor methods, so a surprise in one corner of the format cannot break another.
package transcript
