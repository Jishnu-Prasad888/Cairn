package httpapi

import "context"

// thumbGate bounds how many thumbnails are generated on demand at once.
//
// A thumbnail that the background worker has not made yet is made inside
// the request, which means decoding the full-size original. Scrolling a
// large, not-yet-processed library used to start one decode per tile with no
// limit: the CPU (and on a Raspberry Pi, memory) saturated, every request
// slowed down, and the browser's few connections to the server all sat on
// thumbnails, so navigating elsewhere in the app hung behind them.
type thumbGate struct {
	slots chan struct{}
}

func newThumbGate(n int) *thumbGate {
	if n < 1 {
		n = 1
	}
	return &thumbGate{slots: make(chan struct{}, n)}
}

// acquire waits for a generation slot. It gives up, returning false, when
// ctx ends first: the browser has scrolled past the tile or left the page,
// so nobody is waiting for the result.
func (g *thumbGate) acquire(ctx context.Context) (release func(), ok bool) {
	select {
	case g.slots <- struct{}{}:
		return func() { <-g.slots }, true
	case <-ctx.Done():
		return nil, false
	}
}
