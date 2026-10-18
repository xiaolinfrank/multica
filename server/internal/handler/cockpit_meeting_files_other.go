//go:build !darwin && !linux

package handler

import (
	"errors"
	"os"
)

func openMeetingDirectoryPath(string) (*os.File, error) {
	return nil, errors.New("secure meeting directory operations are not supported on this server platform")
}
func openMeetingDirectoryChild(*os.File, string, bool) (*os.File, error) {
	return nil, errors.New("secure meeting directory operations are not supported on this server platform")
}
