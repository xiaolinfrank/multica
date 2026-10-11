package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// FixedInputManifestHashItem is the immutable byte selection. Names and current
// availability are intentionally excluded: neither changes the authorized bytes.
type FixedInputManifestHashItem struct {
	InputVersionID string `json:"input_version_id"`
	ContentHash    string `json:"content_hash"`
	SizeBytes      int64  `json:"size_bytes"`
	Purpose        string `json:"purpose"`
	Required       bool   `json:"required"`
}

// FixedInputManifestHash binds the complete ordered selection, including an
// explicitly saved empty manifest. Callers validate identifiers and byte facts.
func FixedInputManifestHash(items []FixedInputManifestHashItem) string {
	if items == nil {
		items = []FixedInputManifestHashItem{}
	}
	b, _ := json.Marshal(struct {
		Format string                       `json:"format"`
		Items  []FixedInputManifestHashItem `json:"items"`
	}{"fixed_input_manifest_v1", items})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
