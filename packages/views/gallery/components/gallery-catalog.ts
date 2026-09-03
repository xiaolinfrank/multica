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

/**
 * A drawn plate that came with a work, shown in the carousel above the
 * catalogue.
 *
 * A diagram hangs off the work it documents rather than living in a list of
 * its own, so the carousel's running head is the same string as the card
 * below it and the two cannot drift.
 *
 * Every plate ships at `GALLERY_DIAGRAM_WIDTH` x `GALLERY_DIAGRAM_HEIGHT`, and
 * the frame's 16:9 box matches that exactly — so `object-contain` letterboxes
 * nothing today, and letterboxes rather than cropping the day one arrives
 * off-ratio.
 */
export interface GalleryDiagram {
  id: string;
  /** File name under each platform's static `gallery/` root, extension included. */
  file: string;
  /** The plate's own title, as lettered into the artwork. Also its `alt`. */
  title: string;
  /** The title's first clause — what a picker chip can fit. */
  shortTitle: string;
  /** The reading key: what the plate argues, not its title restated. */
  caption: string;
  /**
   * The plate in words, for a reader who cannot see it.
   *
   * Kept out of `alt` on purpose: a paragraph-long `alt` is its own
   * accessibility failure, so the short `title` identifies the image and this
   * hangs off it through `aria-describedby`.
   */
  description: string;
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
  /** Plates this work was delivered with. The page opens on the first work that has any. */
  diagrams?: GalleryDiagram[];
}

/** The size every hero plate is exported at. */
export const GALLERY_DIAGRAM_WIDTH = 1536;
export const GALLERY_DIAGRAM_HEIGHT = 864;

export const GALLERY_WORKS: GalleryWork[] = [
  {
    id: "platform-overview",
    name: "大湾区 AI + 医药数据平台总体介绍",
    tagline: "对外介绍 · 定位、架构与组织",
    summary:
      "一页讲清平台是什么、为谁建、怎么建：从生命认知走到药物创新的四段价值链，"
      + "中心云与院端可信数据空间的总体架构，以及 3+N 核心牵引与产业生态对接的联合创新组织；"
      + "末尾附平台建设足迹照片。",
    highlights: [
      "价值主张",
      "四段价值链",
      "总体架构",
      "可信数据空间",
      "联合创新组织",
      "产业生态对接",
    ],
    screens: [
      {
        id: "platform-overview",
        name: "总体介绍",
        // No sign-in: a public-facing one-pager that scrolls straight through.
        summary: "从价值主张、总体架构，到联合创新组织与产业生态对接的一页式对外介绍。",
      },
    ],
  },
  {
    id: "jia-cohort",
    name: "JIA 队列建设进展汇报",
    tagline: "幼年特发性关节炎多组学队列 · 价值论证与执行进展",
    summary:
      "三页说清中国首个幼年特发性关节炎多亚型多组学队列：为什么从儿童罕见自免起步——"
      + "机制与成人大适应症互通、儿童早窗信号纯净；回顾性 400 例加前瞻性 600 例的两队列架构；"
      + "一次静脉采血跑通基因组、单细胞、蛋白与代谢的多层设计；"
      + "以及高质量数据集四个维度的执行进展。",
    highlights: [
      "两队列架构",
      "机制互通",
      "儿童早窗",
      "一血多用",
      "24 月纵向随访",
      "确权与资产化",
    ],
    screens: [
      {
        id: "jia-cohort",
        name: "进展汇报",
        // No sign-in: a three-slide deck that pages on the arrow keys, the dots,
        // or a click on either half of the stage.
        summary: "三页翻页式汇报：战略价值与两队列架构、多层组学与临床随访设计、四大维度与执行进展。",
      },
    ],
  },
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
  {
    id: "platform-architecture",
    name: "AI + 医药数据智能体工作平台技术架构设计方案",
    tagline: "系统设计方案 · 交互式解读",
    summary:
      "把《大湾区 AI 医药联合创新平台系统设计方案》读成九个可切换的视图：系统集成、总体分层、技术选型、"
      + "运行时链路、数据出域与三类沙箱、部署形态、六大子平台分工，另附一份按严重度排序的成熟度与冲突清单"
      + "和一张术语对照表。左栏编号即原方案章节号，正文行号与图号逐条标注，可回原文核对。",
    highlights: [
      "系统集成架构",
      "四层总体架构",
      "技术选型全景",
      "运行时闭环",
      "数据出域与沙箱",
      "成熟度与冲突",
    ],
    screens: [
      {
        id: "platform-architecture",
        name: "架构解读",
        // No sign-in: the document opens straight onto its first view.
        summary: "九个视图：系统集成、分层与选型、运行时链路、数据与沙箱、部署形态、子平台分工、成熟度与术语对照。",
      },
    ],
    diagrams: [
      {
        id: "integration",
        file: "architecture-integration.jpg",
        title: "系统集成架构 · 中心云与医院边缘",
        shortTitle: "系统集成架构",
        caption:
          "用户接入在上、运维支撑在下，中间是并置的中心云平台集成层与医院边缘可信数据空间；"
          + "页脚六步串起从提问到报告交付的完整链路。",
        description:
          "四层手绘架构图。上层为用户接入层，科研用户端与运营管理端汇入统一 API 网关；"
          + "中层左侧为中心云平台集成层，智能体平台连接模型管理平台、算力调度平台、数据平台与用户虚拟资源空间；"
          + "中层右侧为医院边缘节点可信数据空间，含安全通道网关、隐私计算引擎与不出院的原始医疗数据；"
          + "下层为运维支撑层。底部标注六步链路：提问、编排拆解、开沙箱分资源、任务下发、结果回流、报告交付。",
      },
      {
        id: "data-lifecycle",
        file: "architecture-data-lifecycle.jpg",
        title: "数据全生命周期 · 三类沙箱与三级分层",
        shortTitle: "数据全生命周期",
        caption:
          "院端一体机治理后本地留存：非敏感数据目录连实体一并上行，敏感数据只出目录与元数据；"
          + "原始层永不放行，分析就绪层编目上行，群体统计量可上行。",
        description:
          "数据全生命周期手绘图。左列为医院侧一体机，自上而下是原始数据源、数据治理流水线、本地存储、"
          + "院端连接器沙箱与可信连接器；右列为平台侧中心云，自上而下是中心侧连接器、数据平台、运营管理端、"
          + "智能体平台与用户虚拟资源空间。两列之间标注上行策略：非敏感数据走目录加实体，敏感数据仅走目录加元数据。"
          + "底部并列三级数据分层：原始层永不放行、分析就绪层编目上行、群体统计量可上行；"
          + "页脚标注三类沙箱的执行位置：院端沙箱、中心沙箱与用户虚拟资源空间，生信镜像由 Nextflow 分发、随沙箱销毁。",
      },
      {
        id: "runtime",
        file: "architecture-runtime.jpg",
        title: "技术流转 · 从科研提问到报告交付",
        shortTitle: "技术流转",
        caption:
          "六条泳道、九个步骤：提问经意图拆解与资源预估落到用户空间，"
          + "执行期按计算、模型、敏感三路分发，敏感步骤只走 DSEP 合约。",
        description:
          "六条泳道的手绘流程图，自上而下为用户统一门户、智能体平台、模型管理平台、数据平台、"
          + "运维平台用户空间、院端可信数据空间。九个步骤依次为科研提问、意图识别与拆解、资源预估、开用户空间、"
          + "资产检索、生成计划 DAG、拉起 Nextflow Runner、执行期三路分发、报告交付；"
          + "底部说明计算步骤、模型步骤与敏感步骤的分发差异。",
      },
    ],
  },
];
