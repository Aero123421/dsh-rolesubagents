# VM設計: 実行検証・ソース確認記録

実施日: 2026-10-23。対応する設計は [vm-execution.md](vm-execution.md)。

**この記録は、VM機能やVM内の隔離を実装済み・動作保証済みとするものではない。** 実DSHを導入して既存プラグインを使い、実行契約とLimaの実装を調べた設計調査である。

## 1. 確認した対象

| 対象 | 固定した版/参照 |
| --- | --- |
| プラグインの実行対象 | main `28d1f62818c42a9c6cb64af361c93157e2926827`、`dsh-rolesubagents@0.2.1` |
| 設計ブランチ | `docs/vm-execution-kiss-design`。mainから作成、PR #13 / #14は変更しない |
| DSH実パッケージ | `@deepseek-ai/dsh@0.2.1-rc.2` |
| DSHソース | `dsh-v0.2.1-rc.2` タグ |
| Lima実バイナリ/ソース | `2.2.1` / `v2.2.1` |
| 最終実行OS | GitHub-hosted Ubuntu 24.04.5 / x86_64 |
| Node / pnpm | 24.21.0 / 10.28.0 |
| DSHインストール用npm | 10.9.2を明示利用。runner既定は11.19.0 |
| ブラウザ | Playwright 1.56.1、Chromium 141.0.7390.37 |

初回のローカル作業環境では外部通信を利用できず、接続端末にも到達できなかったため、専用ブランチの一時的なActionsジョブを使った。各runは新しいrunner、私有 `DSH_HOME` / `LIMA_HOME` / workspaceを使用。ユーザーの稼働中DSH、CLI認証、既存VM、グローバルCLIは変更していない。実モデルへの推論・課金API呼び出しは行っていない。

Actions権限は `contents: read`。インストールするコードは公式npmパッケージとリポジトリ既存コード。Lima配布物は公式releaseのSHA256と照合した。npmの全推移依存を再現可能なlockとして新規保存した検証ではないため、将来完全に同一依存が入る保証までは含まない。

調査用workflowは最終のPR差分から削除する。既存CIを置き換えたり、定期実行を追加したりしない。実行時のworkflowは下記commitに残る。

## 2. 最終確認結果

[成功した実行: 39910436040](https://github.com/Aero123421/dsh-rolesubagents/actions/runs/39910436040)

[実行したworkflowの固定版](https://github.com/Aero123421/dsh-rolesubagents/blob/b2cc299ac37d6d1d96fe8de75d187a2c9bbe0081/.github/workflows/vm-design-research.yml)

job `120271921932`、commit `b2cc299ac37d6d1d96fe8de75d187a2c9bbe0081`。2026-10-23 06:15〜06:17 UTC（15:15〜15:17 JST）。このcommitの製品コードは基準mainと同じで、VMの新実装を実行したわけではない。

| 実施内容 | 結果 | 確認できたこと / 限界 |
| --- | --- | --- |
| 公式DSHの一時prefixへのインストール | 成功 | `dsh --version` = `0.2.1-rc.2` |
| プラグイン開発依存の導入 | 成功 | `pnpm install --frozen-lockfile` |
| 既存の実DSH host統合検証 | **15件成功** | インストール済みDSHのworkflow/registry契約。child backendはテスト用で、VMや実LLMではない |
| プラグインpack・実web profileへの導入 | 成功 | `pnpm pack` → `dsh plugin --profile web add <tgz>` |
| profileの実合成 | 成功 | `--dump-config` にrolesubagentsを確認 |
| DSH Web起動・認証付きアクセス | 成功 | PlaywrightでHTTP 200、非空の描画DOM |
| 実Pluginsページ操作 | 成功 | 初回画面を経由してPluginsを開き、dsh-rolesubagentsを選択 |
| ロール設定画面 | 確認 | `worker` と `External CLIs` を実DOM内に確認 |
| ブラウザpageerror | **0件** | 今回操作した範囲。全UIの品質保証ではない |
| Lima公式tarのSHA256検査 | 成功 | 下記digestに一致 |
| Lima CLI導入・list | 成功 | `limactl version 2.2.1`、専用LIMA_HOMEに既存instanceなし |
| no-mount候補設定の検証 | 成功 | `limactl validate` がOK。実VMの隔離試験ではない |
| /dev/kvm | 利用不可 | このrunnerではKVMアクセスを確認できなかった |
| VM起動・guest実行・終了回収 | **未実施** | Linux/KVMまたはmacOSでの実E2Eが別途必要 |
| HDD性能、TRIM、容量競合、ドライブ抜去 | **未実施** | 設計の受入条件として残す |

ログの主要な観測結果:

```text
Completed 15 installed-host integration checks.
PASS real profile composition includes rolesubagents
PASS authenticated DSH Web HTTP 200 and rendered DOM
PASS installed rolesubagents visible on real Plugins page
ROLE_EDITOR_WORKER_VISIBLE true
ROLE_EDITOR_CLI_SECTION_VISIBLE true
DSH_BROWSER_PAGEERROR_COUNT 0
limactl version 2.2.1
... dsh-vm-isolated.yaml: OK
KVM_UNAVAILABLE: VM boot/E2E not performed
```

UIを開くことと、モデルでタスクを実行することは別である。今回UIからロール保存・モデル設定・実委任は実施していない。VM用UIはまだ存在しない。スクリーンショットに基づく視覚レビューとも異なり、ブラウザ操作とDOM/実行時エラーの確認である。

## 3. 失敗した試行を含む履歴

| run | 結果 | 説明 |
| --- | --- | --- |
| [39909229688](https://github.com/Aero123421/dsh-rolesubagents/actions/runs/39909229688) | 途中失敗 | DSH導入・15件統合・Lima導入は成功。認証なしのroot URLで200を待ったWeb検査が失敗。npm11のinstall script未承認警告も記録されたが、それがWeb失敗の原因とは断定していない |
| [39909651058](https://github.com/Aero123421/dsh-rolesubagents/actions/runs/39909651058) | 途中失敗 | npm10で再導入。15件統合とLima設定検証は成功。Webを認証なしで確認していたため、検査方法を見直した |
| [39910134910](https://github.com/Aero123421/dsh-rolesubagents/actions/runs/39910134910) | 途中失敗 | プラグイン導入、認証付きブラウザ描画、pageerror 0を確認。初回モーダルがPluginsへのクリックを遮り、操作がtimeout |
| [39910436040](https://github.com/Aero123421/dsh-rolesubagents/actions/runs/39910436040) | **成功** | 初回画面を通常操作で処理し、Plugins→ロール設定を開けた。上の結果表の根拠 |

前3回のworkflow failureをDSHの起動不能やLimaの不具合として扱わない。特にDSHのブラウザ入口には起動tokenを使った認証経路があり、無認証URLのHTTP状態だけでは起動確認にならなかった。

認証URL、Cookie、秘密値は公開ログへ出していない。初回失敗時の生ログもそのまま転載せず、必要な診断だけを確認した。最終runではブラウザ・サーバーをfinally/trapで終了し、runner終了時に一時環境を破棄した。

## 4. 検証の再現方法

完全な実行コードは上記固定workflowを参照する。恒久CIに追加する指示ではなく、使い捨て環境での調査手順である。

### DSH

1. Node24.21.0とpnpm10.28.0を用意する。
2. 一時prefixへDSH0.2.1-rc.2を入れ、`DSH_HOME` を新規一時ディレクトリにする。
3. `DSH_CHECKOUT` をインストールしたDSH packageへ向け、リポジトリの `scripts/check-workflow-host.mjs` を実行する。
4. リポジトリをpackし、同じ私有homeのweb profileへ導入する。
5. `dsh web --no-open --host 127.0.0.1 --port 19873` を起動する。
6. 起動ログからローカル認証URLをプログラム内で読み、Playwrightで開く。URL自体をログに出さない。
7. 初回ダイアログを処理し、Plugins → dsh-rolesubagentsを開いて表示を確認する。
8. ブラウザとサーバーを終了する。ユーザーの本番profileをこの手順へ流用しない。

pnpmのpack導入時にはpeer dependency警告が出た。今回のDSHの実解決・起動・UI表示は成立したが、この警告を「すべての配備で無視してよい」と一般化しない。

### Lima

実際に用いた配布物:

```text
lima-2.2.1-Linux-x86_64.tar.gz
SHA256 b391ac7fcac2b2a5a1628107756463188ded4d18d3104a40a66a8bb6fec01bcb
```

[公式release v2.2.1](https://github.com/lima-vm/lima/releases/tag/v2.2.1) から取得し、展開前にdigestを検査した。

実際にvalidateを通した候補設定の生成手順:

```sh
# 必ず使い捨ての専用LIMA_HOMEで行う。VMはこの手順では起動しない。
limactl template copy --fill template:default /tmp/dsh-vm.yaml
limactl template yq /tmp/dsh-vm.yaml \
  '.mounts = [] | .containerd.system = false | .containerd.user = false | .ssh.forwardAgent = false | .ssh.loadDotSSHPubKeys = false | .ssh.forwardX11 = false | .ssh.forwardX11Trusted = false | .portForwards = [{"guestPortRange": [1, 65535], "ignore": true}]' \
  > /tmp/dsh-vm-isolated.yaml
limactl validate /tmp/dsh-vm-isolated.yaml
```

これは構文/設定検証である。展開した設定、global override、実際のmount/forwarding、guest→host通信はVM起動後に別途確認する。既定テンプレートを利用した検証なので、今後の製品で使うimage digestやprovision recipeが確定したわけでもない。

## 5. 読んだコードと設計への影響

全リポジトリを一行残らず読了したという主張ではない。今回の目的に直結する契約、呼び出し元、停止、ファイル操作、容量管理の実装を追った。

### 本プラグイン

基準SHAはすべて `28d1f62818c42a9c6cb64af361c93157e2926827`。

| ソース | 確認と設計への反映 |
| --- | --- |
| [tool.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/host/tool.ts) | ロール選択・RO guardがrunner分岐より前。VM判定を後段だけに追加しても要件を満たさない |
| [readonly.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/host/readonly.ts) | 書込可能roleへのdelegate拒否。host/guestの能力を別に扱う必要 |
| [external/policy.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/host/external/policy.ts) | 親権限の上限・cwd検査。ホスト経路の約束を維持する |
| [external/engine.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/host/external/engine.ts) | spawn前のローカルFS、HOME、temp、resolveExecutable、preflightと停止処理。argvだけのLimaラップでは足りない |
| [external/provider.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/host/external/provider.ts) | ephemeral providerと公式startActivationを再利用する |
| [state.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/host/state.ts) | 既存storageDomainを利用。別DB/常駐管理サービスを増やさない |
| [shared/roles.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/shared/roles.ts) / [runner.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/shared/runner.ts) | runnerと実行場所を分ける。ロールsnapshotとlive CLI設定の境界を意識する |
| [client/RolesPage.tsx](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/client/RolesPage.tsx) / [client/index.ts](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/src/client/index.ts) | 既存設定UIへ統合する。別管理アプリを作らない |
| [check-workflow-host.mjs](https://github.com/Aero123421/dsh-rolesubagents/blob/28d1f62818c42a9c6cb64af361c93157e2926827/scripts/check-workflow-host.mjs) | 15件の検証の実内容。テスト内のguestという語はVM guestを意味しない |

### DSH rc.2

| ソース | 確認と設計への反映 |
| --- | --- |
| [SubagentProvider型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/types.ts) | start/result/dispose、能力宣言、外部providerの契約。独自のタスクランタイムを増やさない |
| [公式DSH SDK provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-dsh-sdk/src/index.ts) | 新しいDSH runtimeを別profile/homeで起動する既存機構 |
| [SDK run](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-dsh-sdk/src/run.ts) | SDKがchildをspawnし、失敗/キャンセル/終了を所有。ctx.subprocess差替えだけではVM化されない |
| [SDK client options](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/client/src/types.ts) | dshBin/processCwd/envはローカル起動の契約。任意SSH transport注入の公開optionはこの型にはない |
| [DSH SSH provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/ssh/ssh/README.md) | fs/process/sandboxをSSHへ送る構成は存在するが、親本体はhostのまま。今回のCLIハーネス全体のVM実行とは別の選択肢 |
| [web-app](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/index.ts) | Loaderのsettlement後の認証URLをreadinessに使う。単なる未認証root HTTP probeを修正 |
| [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/cli/reference/README.md) | 私有profile、plugin pack導入、app引数、--no-openの挙動 |

SDKをguestで使う方式は設計提案であり、今回実際にguestでSDKを起動した証拠ではない。

### Lima v2.2.1

| ソース | 確認と設計への反映 |
| --- | --- |
| [shell.go](https://github.com/lima-vm/lima/blob/v2.2.1/cmd/limactl/shell.go) | askUserForRsyncBackの非TTY経路は直接rsyncBack。`--sync`を標準フローから除外 |
| [clone command](https://github.com/lima-vm/lima/blob/v2.2.1/cmd/limactl/clone.go) / [instance clone](https://github.com/lima-vm/lima/blob/v2.2.1/pkg/instance/clone.go) | 停止済みsource、コピー/CoW、socket path制約。CoWを容量の保証にしない |
| [dirnames.go](https://github.com/lima-vm/lima/blob/v2.2.1/pkg/limatype/dirnames/dirnames.go) | LIMA_HOME、実体パス解決、macOSの短いsocket path。HDD設定も実パスで検査 |
| [downloader.go](https://github.com/lima-vm/lima/blob/v2.2.1/pkg/downloader/downloader.go) | UserCacheDirはLIMA_HOMEと別。既存ローカルファイル等でdigest検査が省略される点も注意 |
| [prune.go](https://github.com/lima-vm/lima/blob/v2.2.1/cmd/limactl/prune.go) | default pruneはdownload cacheの全削除。DSH専用VMのGCとして使わない |

[公式AI例](https://lima-vm.io/docs/examples/ai/) と [Security](https://lima-vm.io/docs/security/) も参照したが、対話向けの便利な説明をDSHの非対話実行へそのまま適用せず、上の実装を根拠に判断した。

## 6. 次の実機検証で確定する項目

- 実VM上でのコピー・編集・回収・停止と、host原本が変わらないこと。
- SSH切断/host crash後にguestの子プロセスを回収できること。
- guestのCLI認証、特にOAuth refreshと並列cloneの可否。未確認の方式をデフォルト対応としない。
- HDD/SSDの実容量計測、CoW無しの複製容量、disk full、予約競合、removable volume。
- guest DSH SDK profileとツール実行guard、ホストプラグインとの分離。
- macOSのsocket path、Limaの実際のmount/forwarding、Linux/KVMでの実制約。

これらは本PRの設計書のrelease gateであり、今回の成功したhost/UI smokeから検証済みへ繰り上げない。
