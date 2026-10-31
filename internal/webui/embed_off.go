//go:build !embedui

package webui

import "io/fs"

// embedded is nil in a build without the embedui tag.
var embedded fs.FS
