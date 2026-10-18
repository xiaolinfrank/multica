package storage

// PrivateArtifactFiles is an explicit provider guarantee: fixed artifact
// objects cannot be read through the provider's anonymous object surface.
// Streaming support alone does not establish that guarantee.
type PrivateArtifactFiles interface {
	SupportsPrivateArtifactFiles() bool
}

func SupportsPrivateArtifactFiles(store any) bool {
	provider, ok := store.(PrivateArtifactFiles)
	return ok && provider.SupportsPrivateArtifactFiles()
}

func (s *LocalStorage) SupportsPrivateArtifactFiles() bool { return s != nil }

// The existing bucket/CDN configuration has no verifiable private namespace.
// Do not infer privacy from a signed URL or from an authenticated upload.
func (s *S3Storage) SupportsPrivateArtifactFiles() bool { return false }
