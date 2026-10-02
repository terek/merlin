//go:build embedui

package webui

import (
	"embed"
	"io/fs"
)

// dist is the build output of web/ (bun run build). Build with: go build -tags embedui.
//
//go:embed all:dist
var dist embed.FS

var embedded = func() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // cannot happen: dist is a directory of this package
	}
	return sub
}()
