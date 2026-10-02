.PHONY: build build-go web web-check test vet

# The UI is embedded, so a build needs bun. build-go, test and vet do not.
build: web
	go build -tags embedui -o bin/merlin ./cmd/explorer

build-go:
	go build -o bin/merlin ./cmd/explorer

web:
	cd web && bun install --frozen-lockfile && bun run build

web-check:
	cd web && bun run check

test:
	go test ./...

vet:
	go vet ./...
