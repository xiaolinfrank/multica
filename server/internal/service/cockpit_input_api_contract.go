package service

import (
	"context"
	"io"
)

// CockpitInputAPI freezes the domain/transport boundary while N2 is built.
// There are no success stubs: IssueService must implement these methods before
// its input capability or routes are enabled in a deployed candidate.
type CockpitInputAPI interface {
	ListCockpitInputAttachments(context.Context, CockpitInputQuery) (CockpitInputAttachmentPage, error)
	GetCockpitInputCapabilities(context.Context, CockpitInputRead) (CockpitInputCapabilities, error)
	ListCockpitInputs(context.Context, CockpitInputQuery) (CockpitInputPage, error)
	GetCockpitInput(context.Context, CockpitInputQuery) (CockpitInputHeader, error)
	CreateCockpitInput(context.Context, CockpitInputRead, CockpitInputCreateInput) (CockpitInputCreateResult, error)
	GetCockpitInputCreateCommand(context.Context, CockpitInputQuery) (CockpitInputCreateResult, error)
	EditCockpitInput(context.Context, CockpitInputQuery, CockpitInputEditInput) (CockpitInputHeader, error)
	ArchiveCockpitInput(context.Context, CockpitInputQuery, CockpitInputArchiveInput) (CockpitInputHeader, error)
	ListCockpitInputVersions(context.Context, CockpitInputQuery) (CockpitInputVersionPage, error)
	GetCockpitInputVersion(context.Context, CockpitInputQuery) (CockpitInputVersionDetail, error)
	GetCockpitInputVersionBatch(context.Context, CockpitInputRead, []string) (CockpitInputVersionBatch, error)
	SubmitCockpitInputVersion(context.Context, CockpitInputQuery, CockpitInputVersionSubmitInput) (CockpitInputVersionResult, error)
	GetCockpitInputVersionCommand(context.Context, CockpitInputQuery) (CockpitInputVersionResult, error)
	ListCockpitInputTransfers(context.Context, CockpitInputQuery) (CockpitInputTransferPage, error)
	GetCockpitInputTransfer(context.Context, CockpitInputQuery) (CockpitInputTransferDetail, error)
	UploadCockpitInputBytes(context.Context, CockpitInputQuery, int64, io.Reader) (CockpitInputUploadResult, error)
	RestartCockpitInputTransfer(context.Context, CockpitInputQuery, CockpitInputRestartInput) (CockpitInputTransferResult, error)
	FinalizeCockpitInputTransfer(context.Context, CockpitInputQuery, CockpitInputFinalizeInput) (CockpitInputTransferResult, error)
	AbandonCockpitInputTransfer(context.Context, CockpitInputQuery, CockpitInputAbandonInput) (CockpitInputTransferResult, error)
	GetCockpitInputTransferCommand(context.Context, CockpitInputQuery) (CockpitInputTransferResult, error)
	VerifyCockpitInputVersion(context.Context, CockpitInputQuery) (CockpitInputVersionMetadata, error)
	ReadCockpitInputFile(context.Context, CockpitInputQuery) (CockpitInputFile, error)
	OpenCockpitInputFile(context.Context, CockpitInputQuery) (CockpitInputFile, io.ReadSeekCloser, error)
	GetCockpitInputManifest(context.Context, CockpitInputQuery) (CockpitInputManifestHeader, error)
	SaveCockpitInputManifest(context.Context, CockpitInputQuery, CockpitInputManifestSaveInput) (CockpitInputManifestResult, error)
	GetCockpitInputManifestCommand(context.Context, CockpitInputQuery) (CockpitInputManifestResult, error)
	ListCockpitInputManifestVersions(context.Context, CockpitInputQuery) (CockpitInputManifestVersionPage, error)
	GetCockpitInputManifestVersion(context.Context, CockpitInputQuery) (CockpitInputManifestVersionDetail, error)
	ListCockpitInputManifestItems(context.Context, CockpitInputQuery) (CockpitInputManifestItemPage, error)
	GetCockpitRunInputManifest(context.Context, CockpitInputQuery) (CockpitRunInputManifest, error)
	RecordCockpitRunInputPreparation(context.Context, CockpitInputQuery, CockpitRunInputPreparationInput) (CockpitRunInputManifest, error)
	ListCockpitInputSpaces(context.Context, CockpitInputRead) (CockpitInputSpacePage, error)
	BrowseCockpitInputSpace(context.Context, CockpitInputRead, string, CockpitInputNASBrowseInput) (CockpitInputNASPage, error)
}

var _ CockpitInputAPI = (*IssueService)(nil)

// This internal descriptor never serializes a storage key. The stream handler
// checks the current principal before storage I/O and again before delivery.
// Origin=artifact_version uses the original private artifact verifier; input
// uses OpenVerifiedInput. Text is the exact immutable UTF-8 byte sequence.
type CockpitInputFile struct {
	WorkspaceID, InputID, VersionID    string
	Origin                             string // input | artifact_version | text
	StorageKey                         string
	Text                               *string
	Filename, ContentType, ContentHash string
	SizeBytes, VersionRevision         int64
}
