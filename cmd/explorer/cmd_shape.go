package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/terek/merlin/internal/shape"
)

func init() {
	register("shape", command{
		usage:   "shape [--json] <path>...",
		summary: "field names, types and counts of JSONL files, never values",
		run:     runShape,
	})
}

func shapeHelp() string {
	d := shape.DefaultOptions()
	return `Usage: merlin shape [--json] [--discriminators L] [--free-form L] [--value-keys L] [--max-depth N] <path>...

Reports the structure of JSONL session files (any harness) so format work can use real
sessions without anyone reading them. Paths are files, or directories walked recursively
for *.jsonl. Read only; reads nothing but the paths given.

Printed: record kinds (from discriminator values, e.g. message/assistant), per kind the field
paths with JSON types, occurrences and "seen in N of M files", and counts of files, records
and bad lines.

Never printed: file names or paths, line contents, parse errors, and values - except short
token values of the keys in --value-keys (type, role, model, ...), and only when the value is
a plain token (no path, address or secret-looking text; '/', ':' and '@' only in model,
modelId and provider values). More than 30 distinct values at one path collapse to a count;
a value that fails the test is counted as "other".

Key names are data too. A key is printed only if it looks like an identifier and not like a
secret; any other key shows as "*", and an object with more than 40 distinct keys at one path
collapses to "*". Children of free-form containers (--free-form) are only counted, as
"<path>.*". Nesting deeper than --max-depth shows as "(deeper)".

Flags (comma separated lists replace the defaults; an empty list means none):
  --json              machine-readable output
  --discriminators L  kind paths, in order (default ` + strings.Join(d.Discriminators, ",") + `)
  --free-form L       container keys not to look inside (default ` + strings.Join(d.FreeForm, ",") + `)
  --value-keys L      keys whose short token values may be printed
                      (default ` + strings.Join(d.ValueKeys, ",") + `)
  --max-depth N       depth limit, at most 64 (default 16)
`
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func runShape(args []string) int {
	d := shape.DefaultOptions()
	fs := flag.NewFlagSet("shape", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "")
	disc := fs.String("discriminators", strings.Join(d.Discriminators, ","), "")
	free := fs.String("free-form", strings.Join(d.FreeForm, ","), "")
	vkeys := fs.String("value-keys", strings.Join(d.ValueKeys, ","), "")
	depth := fs.Int("max-depth", d.MaxDepth, "")
	pos, help, err := parseArgs("shape", fs, shapeHelp(), args)
	if help {
		fmt.Print(shapeHelp())
		return 0
	}
	if err == nil && len(pos) == 0 {
		err = usageError("no path given")
	}
	if err != nil {
		return finish("shape", err)
	}
	opt := shape.Options{Discriminators: splitList(*disc), FreeForm: splitList(*free), ValueKeys: splitList(*vkeys), MaxDepth: *depth}
	rep, err := shape.Scan(pos, opt)
	if err != nil {
		return finish("shape", err)
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return finish("shape", enc.Encode(rep))
	}
	return finish("shape", rep.WriteText(os.Stdout))
}
