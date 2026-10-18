//go:build !darwin && !linux

package cockpitnas

import (
	"context"
	"io"
)

func (f *Files) BrowseInput(context.Context, InputBrowseRequest) (InputBrowsePage, error) {
	return InputBrowsePage{}, fail("unsupported_platform", "NAS input access is unsupported on this server platform.", false)
}
func (f *Files) ObserveInput(context.Context, string, string, string, string, string) (InputObservation, error) {
	return InputObservation{}, fail("unsupported_platform", "NAS input access is unsupported on this server platform.", false)
}
func (f *Files) OpenInput(context.Context, InputObservation) (io.ReadCloser, error) {
	return nil, fail("unsupported_platform", "NAS input access is unsupported on this server platform.", false)
}
