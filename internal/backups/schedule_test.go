package backups

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestScheduleNormalize(t *testing.T) {
	cases := []struct {
		in      Schedule
		wantErr bool
		want    Schedule
	}{
		{in: Schedule{}, want: Schedule{Mode: ScheduleOff}},
		{in: Schedule{Mode: "interval", IntervalMinutes: 60, TimeOfDay: "03:00"}, want: Schedule{Mode: ScheduleInterval, IntervalMinutes: 60}},
		{in: Schedule{Mode: "interval", IntervalMinutes: 1}, wantErr: true},
		{in: Schedule{Mode: "daily"}, want: Schedule{Mode: ScheduleDaily, TimeOfDay: "02:00"}},
		{in: Schedule{Mode: "daily", TimeOfDay: "24:00"}, wantErr: true},
		{in: Schedule{Mode: "weekly", TimeOfDay: "23:30", Weekday: 6}, want: Schedule{Mode: ScheduleWeekly, TimeOfDay: "23:30", Weekday: 6}},
		{in: Schedule{Mode: "weekly", Weekday: 7}, wantErr: true},
		{in: Schedule{Mode: "hourly"}, wantErr: true},
	}
	for _, c := range cases {
		got, err := c.in.Normalize()
		if (err != nil) != c.wantErr {
			t.Errorf("Normalize(%+v) err = %v, wantErr %v", c.in, err, c.wantErr)
			continue
		}
		if !c.wantErr && got != c.want {
			t.Errorf("Normalize(%+v) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestScheduleNextAfter(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02 15:04", s, time.Local)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	daily := Schedule{Mode: ScheduleDaily, TimeOfDay: "02:00"}
	if got := daily.NextAfter(at("2026-10-22 01:00")); !got.Equal(at("2026-10-22 02:00")) {
		t.Errorf("daily before slot = %v", got)
	}
	if got := daily.NextAfter(at("2026-10-22 02:00")); !got.Equal(at("2026-10-23 02:00")) {
		t.Errorf("daily at slot must move to the next day, got %v", got)
	}
	// 2026-10-22 is a Thursday; Sunday is the 25th.
	weekly := Schedule{Mode: ScheduleWeekly, TimeOfDay: "04:15", Weekday: 0}
	if got := weekly.NextAfter(at("2026-10-22 12:00")); !got.Equal(at("2026-10-25 04:15")) {
		t.Errorf("weekly = %v, want Sunday 25th 04:15", got)
	}
	interval := Schedule{Mode: ScheduleInterval, IntervalMinutes: 90}
	if got := interval.NextAfter(at("2026-10-22 12:00")); !got.Equal(at("2026-10-22 13:30")) {
		t.Errorf("interval = %v", got)
	}
}

func TestScheduleDueCatchesUpMissedSlot(t *testing.T) {
	daily := Schedule{Mode: ScheduleDaily, TimeOfDay: "02:00"}
	now := time.Now()
	// The schedule last ran three days ago: the next slot after that is in
	// the past, so a run is owed now (once — the next fire moves it on).
	lastFire := now.Add(-72 * time.Hour)
	due := daily.Due(lastFire, now.Add(-30*24*time.Hour), time.Time{})
	if !due.Before(now) {
		t.Fatalf("due = %v, want a missed slot in the past", due)
	}
	// After firing now, the next slot is in the future.
	if next := daily.Due(now, now.Add(-30*24*time.Hour), time.Time{}); !next.After(now) {
		t.Fatalf("after firing, due = %v, want future", next)
	}
	// A schedule set just now owes nothing for the past, even with an old fire.
	if fresh := daily.Due(lastFire, now, time.Time{}); !fresh.After(now) {
		t.Fatalf("freshly set schedule due = %v, want future", fresh)
	}
}

func TestScheduleIntervalCountsManualBackups(t *testing.T) {
	s := Schedule{Mode: ScheduleInterval, IntervalMinutes: 60}
	fire := time.Date(2026, 10, 22, 8, 0, 0, 0, time.UTC)
	manual := fire.Add(45 * time.Minute)
	if got := s.Due(fire, time.Time{}, manual); !got.Equal(manual.Add(time.Hour)) {
		t.Fatalf("due = %v, want an hour after the manual backup", got)
	}
	// Clock-time schedules ignore manual backups.
	d := Schedule{Mode: ScheduleDaily, TimeOfDay: "09:00"}
	if got := d.Due(fire, time.Time{}, manual); !got.Equal(d.NextAfter(fire)) {
		t.Fatalf("daily due = %v, want next slot after the last fire", got)
	}
}

// TestSchedulePersistsAcrossRestart checks the schedule and its progress
// survive a new Manager loading from the same database: the next run is the
// same instant, not reset to "interval from now".
func TestSchedulePersistsAcrossRestart(t *testing.T) {
	pool, serverPath := tempServerDB(t)
	dir := filepath.Join(t.TempDir(), "backups")
	ctx := context.Background()

	m := newManager(t, pool, serverPath, dir, "", 4)
	if _, err := m.SetSchedule(ctx, Schedule{Mode: ScheduleInterval, IntervalMinutes: 120}); err != nil {
		t.Fatalf("set schedule: %v", err)
	}
	// A run the schedule made after it was set (fires before the schedule
	// existed are ignored by design).
	fired := time.Now().Add(time.Minute).UTC().Truncate(time.Second)
	m.recordFire(ctx, fired)
	want := m.nextDue(ctx)
	if !want.Equal(fired.Add(120 * time.Minute)) {
		t.Fatalf("next due = %v, want %v", want, fired.Add(120*time.Minute))
	}

	again := newManager(t, pool, serverPath, dir, "", 4)
	if err := again.Load(ctx); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := again.Schedule(); got.Mode != ScheduleInterval || got.IntervalMinutes != 120 {
		t.Fatalf("schedule after restart = %+v", got)
	}
	if got := again.nextDue(ctx); !got.Equal(want) {
		t.Fatalf("next due after restart = %v, want %v", got, want)
	}
}

// TestSchedulerRunsMissedBackupAfterRestart drives the real loop: a schedule
// whose slot passed while the "server" was down runs once on start.
func TestSchedulerRunsMissedBackupAfterRestart(t *testing.T) {
	pool, serverPath := tempServerDB(t)
	dir := filepath.Join(t.TempDir(), "backups")
	ctx := context.Background()
	registerLibrary(t, newLibraryManager(pool), filepath.Join(t.TempDir(), "kilo"))

	m := newManager(t, pool, serverPath, dir, "", 4)
	if _, err := m.SetSchedule(ctx, Schedule{Mode: ScheduleInterval, IntervalMinutes: 60}); err != nil {
		t.Fatal(err)
	}
	// Pretend the schedule was set and last ran three hours ago.
	m.mu.Lock()
	m.anchor = time.Now().Add(-4 * time.Hour)
	m.mu.Unlock()
	m.recordFire(ctx, time.Now().Add(-3*time.Hour))

	m.startupDelay = 0
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	m.Start(runCtx)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		recs, _ := m.List(ctx, 10)
		if len(recs) == 1 && recs[0].Status == StatusCompleted {
			if recs[0].Reason != ReasonSchedule {
				t.Fatalf("reason = %q, want schedule", recs[0].Reason)
			}
			// The fire was recorded, so the next run is about an hour out.
			if next := m.nextDue(ctx); time.Until(next) < 50*time.Minute {
				t.Fatalf("next due %v too soon after catch-up", next)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("missed scheduled backup did not run")
}

func TestLoadMarksInterruptedBackupsFailed(t *testing.T) {
	pool, serverPath := tempServerDB(t)
	ctx := context.Background()
	m := newManager(t, pool, serverPath, t.TempDir(), "", 4)
	rec := &Record{ID: "bkp-stale", Status: StatusRunning, Destination: "/x/cairn-backup-1",
		StartedAt: time.Now(), CreatedAt: time.Now(), ServerDB: serverPath}
	if err := m.store.Create(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if err := m.Load(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := m.Get(ctx, "bkp-stale")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusFailed || got.ErrorMsg == "" {
		t.Fatalf("stale record = %s %q, want failed with reason", got.Status, got.ErrorMsg)
	}
}
