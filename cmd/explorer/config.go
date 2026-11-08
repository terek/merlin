package main

import (
	"fmt"
	"os"

	"github.com/terek/merlin/internal/config"
	"github.com/terek/merlin/internal/pricing"
)

// loadConfig reads $MERLIN_HOME/config.json and builds the price table from it. Problems
// with the file are warnings on stderr, prefixed with cmd ("merlin serve"), never errors:
// a bad key falls back to its default. A price table that does not hold together (a
// duplicate alias, an empty model name) is reported and replaced by the built-in table.
func loadConfig(home, cmd string) (config.Config, *pricing.Table) {
	cfg, warns := config.Load(home)
	pricer, err := pricing.WithOverrides(cfg.Prices)
	if err != nil {
		warns = append(warns, fmt.Sprintf("%s: \"prices\": %v; using the built-in prices", config.FileName, err))
		pricer = pricing.Default()
	}
	for _, w := range warns {
		fmt.Fprintf(os.Stderr, "%s: %s\n", cmd, w)
	}
	return cfg, pricer
}
