//go:build !linux

package backups

import "errors"

// The mount table is only read on Linux; elsewhere mount checks are skipped
// and the drive list is empty.
func readMounts() ([]mountEntry, error) { return nil, errors.New("mount table unavailable") }

func diskSpace(string) (total, free uint64) { return 0, 0 }

func deviceRemovable(string) bool { return false }
