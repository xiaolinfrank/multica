/**
 * Skip path, issue 1/2: "Your cloud runtime, and what to do while you wait".
 *
 * Written to a new issue (assigned to the user themselves) by the welcome
 * hook when the user took the Skip exit on Step 3. Content explains the
 * server-centric deployment model: agents run on shared cloud runtimes
 * provisioned by the platform team, so the user never installs anything
 * locally. While waiting for a runtime, the issue walks them through
 * using BayClaw as a lightweight project-management workspace.
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
  en: "Step 1 — Your cloud runtime, and what to do while you wait",
  zh: "第 1 步 —— 了解云端运行时，等待开通时先用起来",
  ko: "1단계 — 클라우드 runtime 안내, 준비되는 동안 할 수 있는 일",
  ja: "ステップ1 — クラウド runtime の案内と、待っている間にできること",
} as const;

const en = `Welcome to BayClaw.

BayClaw's agents run on shared cloud runtimes that the platform team provisions and maintains — there is nothing to download or install. While your workspace's runtime is being set up, you can already use BayClaw as a lightweight project-management workspace.

## Try BayClaw first

Before a runtime is available, you can:

1. Create a project for your current work.
2. Create a few issues and move them across backlog, todo, in_progress, and done.
3. Add priorities, labels, comments, and subscriptions.
4. Use Inbox to track assignments and mentions.

That gives you the project-management layer first. Once a cloud runtime is available, agents can start working from the same issues.

## About your cloud runtime

You never need to install a CLI, run a daemon, or download a desktop app — agents execute on the platform's shared cloud servers.

1. Open the Runtimes page in your workspace to see what's available.
2. If the list is empty, no shared runtime has been enabled for your workspace yet — contact your platform administrator to get one provisioned.
3. Once a runtime shows up as online, simply bind it when creating an agent. No further setup is needed.

When the runtime is online, you can create BayClaw Helper for a guided first run.`;

const zh = `欢迎来到 BayClaw。

BayClaw 的智能体运行在平台团队统一配置和维护的共享云端服务器上——你不需要下载或安装任何软件。在工作区的运行时开通之前，你可以先把 BayClaw 当作轻量项目管理工具用起来。

## 先体验项目管理功能

运行时开通前，你可以先做这些事：

1. 为当前工作创建一个项目。
2. 新建几个 issue，并在 backlog、todo、in_progress、done 之间流转。
3. 给 issue 加优先级、标签、评论和订阅。
4. 用收件箱追踪分配给你的事项和 @mention。

这样你先熟悉项目管理层。云端运行时开通后，智能体会直接在这些 issue 上开始工作。

## 关于云端运行时

你完全不需要安装 CLI、运行守护进程或下载桌面应用——智能体都在平台的共享云端服务器上执行。

1. 打开工作区的 Runtimes 页面，查看当前可用的运行时。
2. 如果列表是空的，说明工作区还没有开通共享运行时——请联系平台管理员为你开通。
3. 运行时显示在线后，创建 agent 时直接绑定它即可，无需任何额外配置。

运行时上线后，你就可以创建 BayClaw Helper，开始一次有智能体参与的上手引导。`;

const ko = `BayClaw에 오신 것을 환영합니다.

BayClaw의 agent는 플랫폼 팀이 미리 구성하고 운영하는 공유 클라우드 runtime에서 실행됩니다. 다운로드하거나 설치할 것은 아무것도 없습니다. 워크스페이스의 runtime이 준비되는 동안에도 BayClaw를 가벼운 프로젝트 관리 워크스페이스로 먼저 사용할 수 있습니다.

## 먼저 BayClaw를 사용해 보기

runtime이 준비되기 전에는 다음을 해볼 수 있습니다:

1. 현재 작업을 위한 project를 만듭니다.
2. issue 몇 개를 만들고 backlog, todo, in_progress, done 사이에서 이동해 봅니다.
3. priority, label, comment, subscription을 추가합니다.
4. Inbox에서 나에게 배정된 작업과 mention을 확인합니다.

이렇게 프로젝트 관리 계층을 먼저 익힐 수 있습니다. 클라우드 runtime이 준비되면 agent가 같은 issue에서 바로 작업을 시작합니다.

## 클라우드 runtime 안내

CLI 설치, daemon 실행, 데스크톱 앱 다운로드는 전혀 필요 없습니다. agent는 플랫폼의 공유 클라우드 서버에서 실행됩니다.

1. 워크스페이스의 Runtimes 페이지를 열어 사용 가능한 runtime을 확인합니다.
2. 목록이 비어 있다면 아직 워크스페이스에 공유 runtime이 개설되지 않은 것입니다. 플랫폼 관리자에게 개설을 요청하세요.
3. runtime이 online으로 표시되면 agent를 만들 때 바로 연결하면 됩니다. 추가 설정은 필요 없습니다.

runtime이 online이 되면 BayClaw Helper를 만들어 안내를 받으며 첫 실행을 시작할 수 있습니다.`;

const ja = `BayClaw へようこそ。

BayClaw の agent は、プラットフォームチームがあらかじめ構成・運用している共有クラウド runtime 上で動作します。ダウンロードやインストールは一切不要です。ワークスペースの runtime が準備される間も、BayClaw を軽量なプロジェクト管理ワークスペースとして先に使うことができます。

## まず BayClaw を使ってみる

runtime が準備できる前に、次のことを試せます:

1. いまの仕事のための project を作る。
2. issue をいくつか作り、backlog、todo、in_progress、done の間で動かしてみる。
3. priority、label、comment、subscription を追加する。
4. Inbox で自分への割り当てや mention を確認する。

これでまずプロジェクト管理のレイヤーに慣れることができます。クラウド runtime が利用可能になると、agent が同じ issue から作業を始められます。

## クラウド runtime について

CLI のインストール、daemon の起動、デスクトップアプリのダウンロードは一切必要ありません。agent はプラットフォームの共有クラウドサーバー上で実行されます。

1. ワークスペースの Runtimes ページを開き、利用可能な runtime を確認します。
2. 一覧が空の場合、ワークスペースにはまだ共有 runtime が開設されていません。プラットフォーム管理者に開設を依頼してください。
3. runtime が online と表示されたら、agent を作成するときにそのまま紐づけられます。追加の設定は不要です。

runtime が online になったら、BayClaw Helper を作成して、案内付きの最初の実行を始められます。`;

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
