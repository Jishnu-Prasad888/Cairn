package backups

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule modes.
const (
	ScheduleOff      = "off"
	ScheduleInterval = "interval"
	ScheduleDaily    = "daily"
	ScheduleWeekly   = "weekly"
)

// Schedule is when backups run on their own. Its progress is persisted (the
// last time it fired), so a server that was stopped picks the schedule up
// where it left off: a slot missed while it was down runs once shortly after
// start, and later slots keep their original rhythm.
type Schedule struct {
	Mode string `json:"mode"`
	// IntervalMinutes is the cadence for interval mode.
	IntervalMinutes int `json:"interval_minutes,omitempty"`
	// TimeOfDay is "HH:MM" in the server's local time zone (daily, weekly).
	TimeOfDay string `json:"time_of_day,omitempty"`
	// Weekday is 0 (Sunday) to 6 (Saturday), for weekly mode.
	Weekday int `json:"weekday,omitempty"`
}

// Normalize validates the schedule and fills defaults.
func (s Schedule) Normalize() (Schedule, error) {
	s.Mode = strings.ToLower(strings.TrimSpace(s.Mode))
	switch s.Mode {
	case "", ScheduleOff:
		return Schedule{Mode: ScheduleOff}, nil
	case ScheduleInterval:
		if s.IntervalMinutes < 5 {
			return s, errors.New("interval must be at least 5 minutes")
		}
		if s.IntervalMinutes > 60*24*90 {
			return s, errors.New("interval must be at most 90 days")
		}
		return Schedule{Mode: s.Mode, IntervalMinutes: s.IntervalMinutes}, nil
	case ScheduleDaily, ScheduleWeekly:
		if s.TimeOfDay == "" {
			s.TimeOfDay = "02:00"
		}
		if _, _, err := parseClock(s.TimeOfDay); err != nil {
			return s, err
		}
		out := Schedule{Mode: s.Mode, TimeOfDay: s.TimeOfDay}
		if s.Mode == ScheduleWeekly {
			if s.Weekday < 0 || s.Weekday > 6 {
				return s, errors.New("weekday must be 0 (Sunday) to 6 (Saturday)")
			}
			out.Weekday = s.Weekday
		}
		return out, nil
	}
	return s, fmt.Errorf("unknown schedule mode %q", s.Mode)
}

// Enabled reports whether the schedule ever fires.
func (s Schedule) Enabled() bool { return s.Mode != "" && s.Mode != ScheduleOff }

func parseClock(v string) (hour, minute int, err error) {
	hs, ms, ok := strings.Cut(strings.TrimSpace(v), ":")
	if ok {
		hour, err = strconv.Atoi(hs)
		if err == nil {
			minute, err = strconv.Atoi(ms)
		}
	}
	if !ok || err != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, 0, fmt.Errorf("time of day must be HH:MM, got %q", v)
	}
	return hour, minute, nil
}

// NextAfter returns the first time strictly after t at which the schedule
// fires. Interval schedules count from t itself.
func (s Schedule) NextAfter(t time.Time) time.Time {
	switch s.Mode {
	case ScheduleInterval:
		return t.Add(time.Duration(s.IntervalMinutes) * time.Minute)
	case ScheduleDaily, ScheduleWeekly:
		h, m, err := parseClock(s.TimeOfDay)
		if err != nil {
			return time.Time{}
		}
		lt := t.In(time.Local)
		next := time.Date(lt.Year(), lt.Month(), lt.Day(), h, m, 0, 0, time.Local)
		for !next.After(lt) || (s.Mode == ScheduleWeekly && int(next.Weekday()) != s.Weekday) {
			// AddDate keeps the wall-clock time across DST changes.
			next = next.AddDate(0, 0, 1)
			next = time.Date(next.Year(), next.Month(), next.Day(), h, m, 0, 0, time.Local)
		}
		return next
	}
	return time.Time{}
}

// Due works out when the next scheduled run is owed. lastFire is when the
// schedule last ran (zero if never), anchor is when the schedule was set, and
// lastBackup is the start of the last completed backup of any kind. A due time
// in the past means a slot was missed and should run now.
//
// Interval schedules count from whichever came last, the last scheduled run or
// any completed backup, so a manual backup also resets the clock. Clock-time
// schedules only count their own runs, so a manual backup at 01:55 does not
// cancel the 02:00 slot.
func (s Schedule) Due(lastFire, anchor, lastBackup time.Time) time.Time {
	if !s.Enabled() {
		return time.Time{}
	}
	// A schedule never owes runs from before it was set.
	base := latest(lastFire, anchor)
	if s.Mode == ScheduleInterval && lastBackup.After(base) {
		base = lastBackup
	}
	if base.IsZero() {
		base = time.Now()
	}
	return s.NextAfter(base)
}

// Describe renders the schedule for logs.
func (s Schedule) Describe() string {
	switch s.Mode {
	case ScheduleInterval:
		return fmt.Sprintf("every %s", (time.Duration(s.IntervalMinutes) * time.Minute).String())
	case ScheduleDaily:
		return "daily at " + s.TimeOfDay
	case ScheduleWeekly:
		return fmt.Sprintf("weekly on %s at %s", time.Weekday(s.Weekday), s.TimeOfDay)
	}
	return "off"
}
