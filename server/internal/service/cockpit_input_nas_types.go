package service

type CockpitInputSpace struct {
	RootID            string   `json:"root_id"`
	RootPath          string   `json:"root_path"`
	InputSubpaths     []string `json:"input_subpaths"`
	RootConfigHash    string   `json:"root_config_hash"`
	CanBrowse         bool     `json:"can_browse"`
	UnavailableReason string   `json:"unavailable_reason"`
}
type CockpitInputSpacePage struct {
	WorkspaceID string              `json:"workspace_id"`
	Items       []CockpitInputSpace `json:"items"` // the existing deployment supports zero or one root
	Total       int64               `json:"total"`
}
type CockpitInputNASBrowseInput struct {
	RelativeDirectory string `json:"relative_directory"`
	Query             string `json:"q"` // current-directory prefix only, never recursive
	Cursor            string `json:"cursor"`
	PageSize          int32  `json:"page_size"`
}
type CockpitInputNASEntry struct {
	CanOpenDirectory  bool    `json:"can_open_directory"`
	Name              string  `json:"name"`
	RelativePath      string  `json:"relative_path"`
	Kind              string  `json:"kind"` // file | directory; unsupported objects cannot be selected
	SizeBytes         *int64  `json:"size_bytes"`
	ModifiedAt        *string `json:"modified_at"`
	ObservationToken  string  `json:"observation_token"`
	CanSelect         bool    `json:"can_select"`
	UnavailableReason string  `json:"unavailable_reason"`
}
type CockpitInputNASPage struct {
	WorkspaceID       string                 `json:"workspace_id"`
	RootID            string                 `json:"root_id"`
	RelativeDirectory string                 `json:"relative_directory"`
	Query             string                 `json:"q"`
	RootConfigHash    string                 `json:"root_config_hash"`
	ObservationToken  string                 `json:"observation_token"`
	PageSize          int32                  `json:"page_size"`
	Items             []CockpitInputNASEntry `json:"items"`
	Total             *int64                 `json:"total"` // null means not counted, never a made-up total
	HasMore           bool                   `json:"has_more"`
	NextCursor        *string                `json:"next_cursor"`
}
