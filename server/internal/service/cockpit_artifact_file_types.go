package service

// CockpitArtifactFile is an internal fixed-object descriptor. StorageKey is
// never serialized into an API response or accepted from a download caller.
// Readers authorize workspace membership before using the scoped DB loader.
type CockpitArtifactFile struct {
	WorkspaceID, ArtifactID, VersionID string
	StorageKey, ContentHash            string
	Filename, ContentType              string
	SizeBytes, VersionRevision         int64
}
