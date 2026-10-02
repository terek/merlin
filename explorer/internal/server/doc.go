// Package server is the read-only JSON API and the Server-Sent Events stream of
// explorer serve. Handlers read the catalog at request time and cache nothing. The
// response shapes are defined in types.go; docs/api.md describes the endpoints.
package server
