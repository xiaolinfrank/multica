package storage

// PrivateInputFiles is a provider guarantee for the input-versions namespace.
// An artifact guarantee alone does not grant this independent capability.
type PrivateInputFiles interface {
	SupportsPrivateInputFiles() bool
}

func SupportsPrivateInputFiles(store any) bool {
	provider, ok := store.(PrivateInputFiles)
	return ok && provider.SupportsPrivateInputFiles()
}

func (s *LocalStorage) SupportsPrivateInputFiles() bool { return s != nil }

// The current bucket/CDN configuration has no verifiable private namespace.
func (s *S3Storage) SupportsPrivateInputFiles() bool { return false }
