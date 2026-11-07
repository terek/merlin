package shape

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
)

// WriteText writes the report for reading. It prints only what Report holds.
func (r *Report) WriteText(w io.Writer) error {
	var b strings.Builder
	fmt.Fprintf(&b, "%d files, %d records, %d bad lines (counted, never shown)", r.Files, r.Records, r.BadLines)
	if r.UnreadableFiles > 0 {
		fmt.Fprintf(&b, ", %d unreadable files", r.UnreadableFiles)
	}
	b.WriteString("\n\nkinds\n")
	tw := tabwriter.NewWriter(&b, 0, 4, 2, ' ', 0)
	for _, k := range r.Kinds {
		fmt.Fprintf(tw, "  %s\t%d records\tin %d of %d files\n", k.Kind, k.Records, k.Files, r.Files)
	}
	tw.Flush()
	for _, k := range r.Kinds {
		fmt.Fprintf(&b, "\n== %s: %d records, seen in %d of %d files\n", k.Kind, k.Records, k.Files, r.Files)
		tw := tabwriter.NewWriter(&b, 0, 4, 2, ' ', 0)
		for _, f := range k.Fields {
			fmt.Fprintf(tw, "  %s\t%s\t%d\t%d of %d files\t%s\n", f.Path, typeList(f.Types), f.Count, f.Files, k.Files, valueList(f))
		}
		tw.Flush()
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func typeList(m map[string]int64) string {
	names := make([]string, 0, len(m))
	for t := range m {
		names = append(names, t)
	}
	sort.Strings(names)
	if len(names) == 1 {
		return names[0]
	}
	parts := make([]string, len(names))
	for i, t := range names {
		parts[i] = fmt.Sprintf("%s:%d", t, m[t])
	}
	return strings.Join(parts, "|")
}

func valueList(f Field) string {
	var parts []string
	for _, v := range f.Values {
		parts = append(parts, fmt.Sprintf("%s(%d)", v.Value, v.Count))
	}
	if f.Collapsed {
		parts = append(parts, collapsedNote)
	}
	if f.OtherValues > 0 {
		parts = append(parts, fmt.Sprintf("other(%d)", f.OtherValues))
	}
	if len(parts) == 0 {
		return ""
	}
	return "= " + strings.Join(parts, " ")
}
