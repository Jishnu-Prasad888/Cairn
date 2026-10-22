package backups

import (
	"context"
	"errors"
	"time"
)

// Start launches the scheduler goroutine. Call it exactly once, after Load.
//
// The scheduler owns three kinds of run:
//   - scheduled runs, whose progress is persisted so a stopped server resumes
//     the rhythm, running a slot it missed once shortly after start;
//   - size-triggered runs, when enough new data has been indexed since the
//     last backup;
//   - Trigger requests.
//
// A run whose destination is unavailable (drive unplugged, server down) does
// not record a failure: the scheduler waits and tries again, so a backup drive
// that is only connected now and then still gets its backups.
func (m *Manager) Start(ctx context.Context) {
	if !m.Destination().Configured() {
		m.logger.Info("backups disabled until a backup destination is configured")
	}
	if s := m.Schedule(); s.Enabled() {
		m.logger.Info("backup scheduler started", "schedule", s.Describe(),
			"keep", m.cfg.Keep, "encrypted", m.cfg.Passphrase != "")
	}
	go m.loop(ctx)
}

func (m *Manager) loop(ctx context.Context) {
	started := time.Now()
	var (
		retryAt     time.Time // a due scheduled run waits for its destination
		sizeCheckAt = started.Add(m.startupDelay)
		sizeBackoff time.Time // after a size-triggered run failed or waited
	)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-m.wake:
			sizeCheckAt = time.Now()
		case <-m.trigger:
			// runLogged has already logged the outcome; a manual trigger is
			// not retried.
			_ = m.runLogged(ctx, ReasonManual, 4*time.Hour)
		}

		now := time.Now()
		due := m.nextDue(ctx)
		settled := !now.Before(started.Add(m.startupDelay))

		if !due.IsZero() && !now.Before(due) && !now.Before(retryAt) && settled {
			err := m.runLogged(ctx, ReasonSchedule, 12*time.Hour)
			if waitable(err) {
				retryAt = now.Add(m.retryFor(err))
				m.setWaiting(err.Error(), retryAt)
			} else {
				retryAt = time.Time{}
				m.setWaiting("", time.Time{})
				m.recordFire(ctx, now)
			}
			due = m.nextDue(ctx)
		}

		tr := m.Triggers()
		if tr.Enabled() && !now.Before(sizeCheckAt) && !now.Before(sizeBackoff) && settled {
			sizeCheckAt = now.Add(m.sizeCheckEvery)
			if why, ok := m.sizeExceeded(ctx, tr); ok {
				m.logger.Info("backup size trigger reached", "why", why)
				err := m.runLogged(ctx, ReasonSize, 12*time.Hour)
				switch {
				case waitable(err):
					sizeBackoff = now.Add(m.retryFor(err))
					m.setWaiting(err.Error(), sizeBackoff)
				case err != nil:
					sizeBackoff = now.Add(3 * m.retryDelay)
				default:
					m.setWaiting("", time.Time{})
				}
			}
		}

		// Sleep until the next thing to do, waking at least hourly so clock
		// and time-zone changes are noticed.
		next := now.Add(time.Hour)
		if !due.IsZero() {
			next = earliest(next, latest(due, retryAt, started.Add(m.startupDelay)))
		}
		if tr.Enabled() {
			next = earliest(next, latest(sizeCheckAt, sizeBackoff))
		}
		wait := max(time.Until(next), time.Second)
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
	}
}

// runLogged runs a backup in the background context with a timeout, logging
// the outcome. The error is that of starting the run; a run that started and
// failed is recorded and returns a non-nil, non-waitable error.
func (m *Manager) runLogged(ctx context.Context, reason string, timeout time.Duration) error {
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	rec, err := m.runExclusive(rctx, reason)
	if err != nil {
		if waitable(err) {
			m.logger.Info("backup waiting", "reason", reason, "why", err)
		} else {
			m.logger.Error("backup run errored", "reason", reason, "error", err)
		}
		return err
	}
	m.logger.Info("backup run finished", "backup_id", rec.ID, "reason", reason, "status", rec.Status,
		"files", rec.Files, "bytes", rec.Bytes, "stored_bytes", rec.StoredBytes)
	if rec.Status != StatusCompleted {
		return errors.New(rec.ErrorMsg)
	}
	return nil
}

// waitable reports whether a run should simply be tried again later.
func waitable(err error) bool {
	return errors.Is(err, ErrUnavailable) || errors.Is(err, errBusy)
}

func (m *Manager) retryFor(err error) time.Duration {
	if errors.Is(err, errBusy) {
		return min(time.Minute, m.retryDelay)
	}
	return m.retryDelay
}

// nextDue is when the schedule next owes a run (zero when off).
func (m *Manager) nextDue(ctx context.Context) time.Time {
	m.mu.RLock()
	s, lastFire, anchor := m.schedule, m.lastFire, m.anchor
	m.mu.RUnlock()
	if !s.Enabled() || !m.Destination().Configured() {
		return time.Time{}
	}
	lastBackup, _ := m.store.LastCompleted(ctx)
	if anchor.IsZero() && lastFire.IsZero() && lastBackup.IsZero() {
		// An environment-configured schedule with no history: count from
		// the first time this server saw it, persisted so restarts keep it.
		anchor = time.Now().UTC()
		m.recordFire(ctx, anchor)
	}
	return s.Due(lastFire, anchor, lastBackup)
}

// sizeExceeded checks the new data since the last backup against tr.
func (m *Manager) sizeExceeded(ctx context.Context, tr Triggers) (string, bool) {
	if !m.Destination().Configured() {
		return "", false
	}
	p, err := m.pending(ctx)
	if err != nil {
		m.logger.Warn("backup size check failed", "error", err)
		return "", false
	}
	return tr.Exceeds(p)
}

func (m *Manager) pending(ctx context.Context) (Pending, error) {
	since, err := m.store.LastCompleted(ctx)
	if err != nil {
		return Pending{}, err
	}
	libs, err := m.libs.List(ctx)
	if err != nil {
		return Pending{}, err
	}
	return pendingSince(ctx, libs, since)
}

func (m *Manager) setWaiting(why string, until time.Time) {
	m.stateMu.Lock()
	m.waiting, m.nextTry = why, until
	m.stateMu.Unlock()
}

// SchedulerStatus is the scheduler's view for the API.
type SchedulerStatus struct {
	Running bool `json:"running"`
	// NextScheduledAt is when the schedule next runs; zero when off. A time
	// in the past means a missed run is about to happen.
	NextScheduledAt time.Time `json:"next_scheduled_at"`
	LastRunAt       time.Time `json:"last_scheduled_run_at"`
	// Waiting explains a due run that cannot start yet (drive unplugged,
	// server unreachable) and RetryAt when it is tried again.
	Waiting string    `json:"waiting,omitempty"`
	RetryAt time.Time `json:"retry_at"`
	// Pending is what has been added or changed since the last backup.
	Pending Pending `json:"pending"`
}

// SchedulerStatus reports the scheduler's state.
func (m *Manager) SchedulerStatus(ctx context.Context) SchedulerStatus {
	st := SchedulerStatus{Running: m.Running(), NextScheduledAt: m.nextDue(ctx)}
	m.mu.RLock()
	st.LastRunAt = m.lastFire
	m.mu.RUnlock()
	m.stateMu.Lock()
	st.Waiting, st.RetryAt = m.waiting, m.nextTry
	m.stateMu.Unlock()
	if p, err := m.pending(ctx); err == nil {
		st.Pending = p
	}
	return st
}

func earliest(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

func latest(ts ...time.Time) time.Time {
	var out time.Time
	for _, t := range ts {
		if t.After(out) {
			out = t
		}
	}
	return out
}
