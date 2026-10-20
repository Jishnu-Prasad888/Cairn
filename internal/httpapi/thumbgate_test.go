package httpapi

import (
	"context"
	"testing"
	"time"
)

func TestThumbGateBoundsAndGivesUp(t *testing.T) {
	g := newThumbGate(1)
	release, ok := g.acquire(context.Background())
	if !ok {
		t.Fatal("first acquire failed")
	}

	// A second caller waits; when its client goes away it gives up.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, ok := g.acquire(ctx); ok {
		t.Fatal("acquired a second slot of a one-slot gate")
	}

	release()
	release2, ok := g.acquire(context.Background())
	if !ok {
		t.Fatal("slot was not returned")
	}
	release2()
}
