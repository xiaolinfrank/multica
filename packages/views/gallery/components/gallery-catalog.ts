/**
 * The showcase catalogue: what the workspace has delivered.
 *
 * This is committed content, not server state. Each entry points at a
 * self-contained prototype shipped under each platform's static root (see
 * `gallery-asset-src.ts` for why there are two copies), so the gallery has
 * nothing to fetch and works offline in both the web app and the desktop
 * shell.
 *
 * Names and summaries stay untranslated on purpose. They are the delivered
 * artefact's own identity — a product name and the customer-facing pitch that
 * came with it — the same way an agent's or a project's name is not run
 * through i18n. Only the surrounding chrome (buttons, labels, counts) lives in
 * `locales/*\/gallery.json`.
 */

/**
 * The sign-in a prototype accepts.
 *
 * Our copies of the prototypes ship with these already filled into the login
 * form, so a viewer only has to press the button. They are still surfaced in
 * the viewer, because the prototypes clear both fields on sign-out and a demo
 * you cannot get back into is a demo that ends at the first stray click.
 *
 * Per screen, not per work: the three gated prototypes validate differently.
 * Keep an entry in step with the `value=` attributes on that document's
 * `#loginAccount` / `#loginPassword` inputs.
 */
export interface PrototypeCredentials {
  account: string;
  password: string;
}

export interface GalleryScreen {
  /** Stable id; also the prototype's file stem under `/gallery/`. */
  id: string;
  name: string;
  summary: string;
  /** Absent when the prototype drops straight into its main view. */
  credentials?: PrototypeCredentials;
}

export interface GalleryWork {
  id: string;
  name: string;
  /** One-line positioning shown next to the title. */
  tagline: string;
  summary: string;
  /** Short capability chips rendered under the summary. */
  highlights: string[];
  screens: GalleryScreen[];
}

export const GALLERY_WORKS: GalleryWork[] = [
  {
    id: "ai-pharma-workbench",
    name: "智能体药研工作台",
    tagline: "AI + 医药数据平台",
    summary:
      "面向药物研发团队的一体化协作平台：把项目、任务、数据资产与智能体自动化收进同一个工作台，"
      + "并为数据提供方与平台运营方各配一套管理后台，形成完整的数据流转闭环。",
    highlights: [
      "科研协作",
      "项目与任务",
      "自动化编排",
      "数据资产目录",
      "供数方接入",
      "平台运营管理",
    ],
    screens: [
      {
        id: "user-portal",
        name: "用户端",
        summary: "科研人员的日常入口：消息、通讯录、项目、任务、自动化、云盘与应用市场。",
        // Hard-coded to this pair: any other account is rejected.
        credentials: { account: "admin", password: "123456" },
      },
      {
        id: "admin-console",
        name: "管理端",
        summary: "平台运营后台：组织与账号、权限角色、数据安全策略与运营看板。",
        // Validated against the prototype's own user list, where `zhangwei`
        // (系统管理员) is the only account not forced through a first-login
        // password change. "admin" does not exist there.
        credentials: { account: "zhangwei", password: "123456" },
      },
      {
        id: "data-provider-console",
        name: "供数方平台",
        summary: "数据提供方的数据管理台：数据目录维护与对外供数的申请审批。",
        // Accepts any non-empty pair; we prefill the same one as the portal.
        credentials: { account: "admin", password: "123456" },
      },
      {
        id: "mobile-app",
        name: "移动端",
        // The prototype draws its own phone shell centred on a backdrop, so a
        // full-width frame already presents it at 1:1.
        summary: "手机上的科研协作：会话列表与群聊详情，随时跟进项目进展。",
      },
    ],
  },
];
