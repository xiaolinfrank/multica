//go:build !darwin && !linux

package cockpitnas

import "context"

func (f *Files) InspectPreparation(context.Context, PreparationTarget, []string) ([]PreparationInspection, error) {
	return nil, fail("unsupported_storage", "Directory preparation is unsupported on this platform.", false)
}
func (f *Files) EnsurePreparedDirectory(context.Context, PreparationTarget, string) (PreparationObservation, error) {
	return PreparationObservation{}, fail("unsupported_storage", "Directory preparation is unsupported on this platform.", false)
}
