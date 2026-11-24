//go:build !darwin && !linux

package collabfs

import (
	"errors"
	"os"
)

var errUnsupported = errors.New("secure collaboration-space operations are not supported on this server platform")

func openPath(string) (*os.File, error)                  { return nil, errUnsupported }
func openChild(*os.File, string, bool) (*os.File, error) { return nil, errUnsupported }
func isCrossDevice(error) bool                           { return false }
func copyTree(string, string) error                      { return errUnsupported }
func removeTree(string) error                            { return errUnsupported }
