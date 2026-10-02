package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefaultPort is the daemon's port when config.json does not set one.
const DefaultPort = 7433

// Timeout is the total budget for reading the event and delivering it.
const Timeout = 150 * time.Millisecond

const maxBody = 4 << 20

// Port returns the daemon port configured under explorerHome.
func Port(explorerHome string) int { return configPort(explorerHome) }

// Notify reads one hook event from stdin and POSTs it to the daemon's /hook
// endpoint on 127.0.0.1:port, all within timeout. It returns an error for
// anything that went wrong; the caller is expected to ignore it.
func Notify(stdin io.Reader, port int, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	type readResult struct {
		body []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		b, err := io.ReadAll(io.LimitReader(stdin, maxBody))
		ch <- readResult{b, err}
	}()
	var body []byte
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		body = r.body
	case <-ctx.Done():
		return ctx.Err()
	}
	if !json.Valid(body) {
		return fmt.Errorf("stdin is not JSON")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/hook", port), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil}}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	return nil
}
