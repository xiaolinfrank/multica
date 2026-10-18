package main

import (
	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/handler"
)

func registerCockpitInputRoutes(r chi.Router, h *handler.Handler) {
	r.Get("/inputs/capabilities", h.GetCockpitInputCapabilities)
	r.Get("/inputs", h.ListCockpitInputs)
	r.Post("/inputs", h.CreateCockpitInput)
	r.Get("/inputs/commands/{commandKey}", h.GetCockpitInputCreateCommand)
	r.Get("/input-versions", h.GetCockpitInputVersionBatch)
	r.Route("/inputs/{inputId}", func(r chi.Router) {
		r.Get("/", h.GetCockpitInput)
		r.Patch("/", h.EditCockpitInput)
		r.Post("/archive", h.ArchiveCockpitInput)
		r.Get("/versions", h.ListCockpitInputVersions)
		r.Post("/versions", h.SubmitCockpitInputVersion)
		r.Get("/version-commands/{commandKey}", h.GetCockpitInputVersionCommand)
		r.Route("/versions/{versionId}", func(r chi.Router) {
			r.Get("/", h.GetCockpitInputVersion)
			r.Post("/restart", h.RestartCockpitInputTransfer)
			r.Get("/transfer-commands/{commandKey}", h.GetCockpitInputTransferCommand)
			r.Post("/verify", h.VerifyCockpitInputVersion)
			r.Get("/transfers", h.ListCockpitInputTransfers)
			r.Route("/transfers/{transferId}", func(r chi.Router) {
				r.Get("/", h.GetCockpitInputTransfer)
				r.Put("/bytes", h.UploadCockpitInputBytes)
				r.Post("/finalize", h.FinalizeCockpitInputTransfer)
				r.Post("/abandon", h.AbandonCockpitInputTransfer)
				r.Get("/commands/{commandKey}", h.GetCockpitInputTransferCommand)
			})
		})
	})
	r.Get("/issues/{issueId}/input-attachments", h.ListCockpitInputAttachments)
	r.Get("/issues/{issueId}/input-manifest", h.GetCockpitInputManifest)
	r.With(handler.RequireHumanActor).Put("/issues/{issueId}/input-manifest", h.SaveCockpitInputManifest)
	r.Get("/issues/{issueId}/input-manifest/commands/{commandKey}", h.GetCockpitInputManifestCommand)
	r.Get("/issues/{issueId}/input-manifest/versions", h.ListCockpitInputManifestVersions)
	r.Get("/issues/{issueId}/input-manifest/versions/{manifestVersionId}", h.GetCockpitInputManifestVersion)
	r.With(handler.RequireHumanActor).Get("/input-spaces", h.ListCockpitInputSpaces)
	r.With(handler.RequireHumanActor).Post("/input-spaces/{rootId}/entries", h.BrowseCockpitInputSpace)
}
