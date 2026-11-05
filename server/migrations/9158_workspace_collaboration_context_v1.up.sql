-- Freeze this v1 seed; only previously empty workspaces receive it.
-- The guarded update preserves concurrent non-empty user edits.
UPDATE workspace
SET context = $workspace_context_v1$### 人机协作空间路径

项目的 `collab_path`（人机协作空间路径）是该项目唯一的持久交付根目录。标准单机部署使用本机内建磁盘，不依赖 NAS。任务 workdir 是执行机器上的私有草稿区，用于过程文件、代码检出和临时数据，不能充当交付目录。

目录层级：有模块时为 `<项目 collab_path>/<模块 directory_name>/<任务或成果目录>/`；没有模块时为 `<项目 collab_path>/<任务或成果目录>/`。报告、数据集、PPT、导出文件等必须进入对应任务或成果子目录，不能平铺在项目根目录或模块根目录，也不要为无模块任务伪造模块。

模块没有独立的绝对协作空间路径。使用已绑定的稳定相对目录 `module.directory_name`（任务简报/资源清单中的 `module_directory`），而不是改名后的模块标题。初建目录名称可以来自模块名，绑定后改标题不会重建目录或搬移文件。绑定为空、不安全或存在歧义时先报告并请求明确绑定，不猜目录。

写入前确认项目绑定、执行主机、目录归属、可写权限和路径包含关系。只有已确认属于本机可写内建磁盘的明确绑定，才可以创建缺失的项目目录及其模块、任务子目录。未配置、不可访问或权限不足要按实际情况报告，保留成果在 workdir，不能声称持久交付成功。目录缺失不代表 NAS 未挂载；不要另找“差不多”的路径，不要擅自挂载或改绑定。

工单交付仍按任务简报 `## Output` 使用 `--attachment <path>` 上传，让阅读者真正收到文件；协作空间副本是额外归档，不能替代附件。附件上传也必须在用户授权范围内：用户要求大文件等待确认时先准备并保留文件，得到确认后再上传。其他任务表面遵守其 `## Output` 的交付方式。

仅在 `## Output` 允许的位置报告写入的完整路径，使用纯文本，不生成可点击文件链接或 `file://` 链接。未经允许的表面不得额外报告路径。
$workspace_context_v1$, updated_at = now()
WHERE context IS NULL OR context !~ '[^[:space:]]';
