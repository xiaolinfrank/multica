/**
 * Skip-path issue: inspect the connected runtime before configuring another device.
 * Persisted onboarding copy is deployment-neutral: a runtime may be local or remote.
 */

/**
 * Step 1 of the skip-path bundle. Localized so users see the title in
 * their current supported locale on the board.
 *
 * Note: since v3 this title is fully decoupled from the server-side
 * deprecation shim (`onboarding_shim.go:noRuntimeIssueTitle`). That shim
 * keeps its own bare English string for title-based dedupe and only runs
 * for pre-v3 desktop builds, which never overlap with the v3 frontend
 * population — so the title here can change freely without breaking
 * any dedupe.
 */
export const INSTALL_RUNTIME_ISSUE_TITLE = {
  en: "Step 1 — Check your connected runtime",
  zh: "第 1 步 —— 检查已连接的运行时",
  ko: "1단계 — 연결된 runtime 확인",
  ja: "ステップ1 — 接続済み runtime を確認",
} as const;

const en = `Welcome to BayClaw.

BayClaw is the project and task execution workbench coordinated by your Xingduo personal counterpart. Agents execute on the runtimes connected to this instance; their location depends on your deployment and can be local or remote.

## Check the existing runtime first

1. Open the Runtimes page in your workspace and check which runtimes are online and accessible to you.
2. The single-user Mac release includes its own CLI and worker. Check their status before installing anything again.
3. If no suitable runtime is online, inspect the instance's service status and permissions. Configure the CLI and daemon through the existing connection flow only when adding another device or a runtime this instance does not already provide.
4. When a suitable runtime is online, bind it when creating an agent. Model and tool authorization still belong to the user of this instance.

## Use project management while a runtime is unavailable

1. Create a project for your current work.
2. Create a few tasks and move them across backlog, todo, in_progress, and done.
3. Add priorities, labels, comments, and subscriptions.
4. Use Inbox to track assignments and mentions.

Once the runtime is ready, agents can work from the same tasks. You can then create BayClaw Helper for a guided first run.`;

const zh = `欢迎来到 BayClaw。

BayClaw 是由星舵个人分身统筹的项目与任务执行工作台。智能体在本实例已连接的运行时中执行；执行位置取决于实际部署，可以是本机或获准的远程设备。

## 先检查已有运行时

1. 打开工作区的运行时页面，检查哪些运行时在线，以及你是否有权使用。
2. 单人 Mac 发行包已经包含本实例的 CLI 和 worker，请先核对状态，不要重复安装。
3. 若没有合适的在线运行时，先检查实例服务和权限。仅在接入其他设备，或需要本实例尚未提供的运行时之时，再按既有连接流程配置 CLI 和守护进程。
4. 合适的运行时在线后，创建智能体时绑定它。模型和工具仍需本实例用户自己的授权。

## 运行时暂不可用时先管理项目

1. 为当前工作创建一个项目。
2. 新建几个任务，并在 backlog、todo、in_progress、done 之间流转。
3. 给任务加优先级、标签、评论和订阅。
4. 用收件箱追踪分配给你的事项和提及。

运行时就绪后，智能体可以继续处理这些任务。届时可创建 BayClaw Helper，开始一次有智能体参与的上手引导。`;

const ko = `BayClaw에 오신 것을 환영합니다.

BayClaw는 Xingduo 개인 분신이 조율하는 프로젝트 및 작업 실행 워크벤치입니다. agent는 이 인스턴스에 연결된 runtime에서 실행되며, 실제 배포에 따라 로컬 또는 허가된 원격 장치를 사용할 수 있습니다.

## 기존 runtime부터 확인하기

1. 워크스페이스의 Runtimes 페이지에서 online 상태와 사용 권한을 확인합니다.
2. 단일 사용자 Mac 릴리스에는 이 인스턴스의 CLI와 worker가 포함되어 있습니다. 다시 설치하기 전에 상태를 확인하세요.
3. 적절한 runtime이 없다면 먼저 인스턴스 서비스와 권한을 점검합니다. 다른 장치나 아직 제공되지 않은 runtime을 연결할 때만 기존 연결 절차에 따라 CLI와 daemon을 구성합니다.
4. 적절한 runtime이 online이면 agent를 만들 때 연결합니다. 모델과 도구에는 이 인스턴스 사용자의 별도 권한이 필요합니다.

## runtime을 사용할 수 없을 때 프로젝트 관리하기

1. 현재 작업을 위한 project를 만듭니다.
2. 태스크 몇 개를 만들고 backlog, todo, in_progress, done 사이에서 이동해 봅니다.
3. priority, label, comment, subscription을 추가합니다.
4. Inbox에서 나에게 배정된 작업과 mention을 확인합니다.

runtime이 준비되면 agent가 같은 작업을 계속 처리할 수 있습니다. BayClaw Helper를 만들어 안내를 받으며 첫 실행을 시작할 수 있습니다.`;

const ja = `BayClaw へようこそ。

BayClaw は Xingduo の個人分身が統括するプロジェクトとタスクの実行ワークベンチです。agent はこのインスタンスに接続された runtime で動作し、実際の構成に応じてローカルまたは許可されたリモート端末を利用します。

## 既存の runtime を先に確認

1. ワークスペースの Runtimes ページで、online 状態と利用権限を確認します。
2. シングルユーザー Mac リリースには、このインスタンスの CLI と worker が含まれます。再インストールする前に状態を確認してください。
3. 適切な runtime がない場合は、まずインスタンスのサービスと権限を確認します。別の端末や未提供の runtime を接続する場合にのみ、既存の接続手順で CLI と daemon を構成します。
4. 適切な runtime が online になったら agent 作成時に紐づけます。モデルやツールには、このインスタンスのユーザーによる別途の認可が必要です。

## runtime が利用できない間のプロジェクト管理

1. いまの仕事のための project を作る。
2. タスクをいくつか作り、backlog、todo、in_progress、done の間で動かしてみる。
3. priority、label、comment、subscription を追加する。
4. Inbox で自分への割り当てや mention を確認する。

runtime の準備が整ったら、agent が同じタスクを続けられます。BayClaw Helper を作成して最初の実行を始められます。`;

export const INSTALL_RUNTIME_ISSUE_BODY = { en, zh, ko, ja } as const;

/**
 * Prefix sentence for the follow-up comment posted on this issue (the one
 * that links to the create-agent-guide issue via a mention chip). Kept
 * here as a TS const rather than an i18n JSON key because anything that
 * gets persisted to the DB must be available at write time without
 * depending on an i18n bundle having loaded the new key — otherwise a
 * cold dev server / stale build writes the raw key string into
 * `comment.content` and the comment is permanently broken.
 */
export const FOLLOWUP_COMMENT_PREFIX = {
  en: "Your next step:",
  zh: "完成后的下一步：",
  ko: "다음 단계:",
  ja: "次のステップ:",
} as const;
