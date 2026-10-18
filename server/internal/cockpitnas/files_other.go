//go:build !darwin && !linux

package cockpitnas

import "context"

const platformSupported = false

func (f *Files) Write(context.Context, Request) (Result, error) {
	return Result{}, fail("unsupported_platform", "NAS export is not supported on this server platform.", false)
}

func (f *Files) VerifyAttempt(context.Context, Request) (Result, error) {
	return Result{}, fail("unsupported_platform", "NAS export is not supported on this server platform.", false)
}
