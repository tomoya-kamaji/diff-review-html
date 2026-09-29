---
name: diff-review-html
description: >-
  Groups a large git diff into intent-based review units and writes a single
  local HTML app. Use when the user wants 差分をレビューしやすく, 大きい diff を理解,
  diff review, グループ分けしてレビュー, or /diff-review-html. Prefer this for
  review walkthroughs; use explain-diff-html for teaching a change.
disable-model-invocation: true
---

# diff-review-html

大きな git 差分を意図ごとのグループに分け、単一 HTML で読む Skill。

## パス

`SKILL_ROOT` は、この `SKILL.md` があるディレクトリ。個人スキルでも Plugin でも同じ。

`~/.cursor/skills/diff-review-html` は使わない。スクリプトは `$SKILL_ROOT/scripts/` から実行する。

出力先は `$HOME/.cursor/diff-review/`（`open_resource` が開ける場所）。`/tmp` には書かない。

## 責務

- スクリプトが決定的部分を担う: 差分取得、hunk 分解、ID、seed、signals、検証、HTML 注入
- AI は `groups.json` だけを書く。HTML を直接書かない
- レビュー UI を変えるときは `templates/app.html` を直し、`build-review.mjs` で描画する。生成 HTML を手編集しない
- 厳格なマージ前レビューは各リポジトリの code-review Skill に任せる

## 手順

1. スコープを決める。ユーザー指定がなければ dirty なら未コミット、clean なら既定ブランチとの merge-base。PR 番号なら `gh pr view <n> --json baseRefName` で base を取り `--base origin/<base>` を使う。
2. モデルを作る。

```bash
SKILL_ROOT="<この SKILL.md のディレクトリ>"
mkdir -p "$HOME/.cursor/diff-review"
node "$SKILL_ROOT/scripts/diff-model.mjs" \
  [--uncommitted | --base <ref> | --range <a>..<b>] \
  --out "$HOME/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.model.json"
```

3. model.json を読む（stats / seeds / signals / hunks）。`meta` 付き hunk（rename-only / binary）もグループに入れる。意図が取れない hunk だけ該当ファイルを Read する。広範な探索はしない。大きい model.json は全文 Read せず、`node -e` で files / seeds / signals を要約してから必要な hunk だけ読む。
   - file tags: `test` / `docs` / `generated` / `config` / `migration` / `data`（json・csv 等のデータファイル）。`generated` と `data` の 1000 行超 hunk は先頭 40 行のみ HTML に埋め込まれる
4. `reference/groups-schema.md` に従い `$HOME/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.groups.json` を書く。seed は結合のみ、分割しない。読む順（基盤 → 依存側 → テスト → docs、generated は末尾）。`problem` / `core` / `doneWhen` を書く。実装グループには `annotations`（goal と hunkId）を 2〜4 件。走査の hunk 行と、開いた hunk の中身に出る。generated と薄い docs は省略可。改善点は `improve`、意図不明は `unclear`、解説は必要な hunk だけ `note`。
5. 描画する。検証エラーなら groups.json を直して再実行する。

```bash
node "$SKILL_ROOT/scripts/build-review.mjs" \
  --model "$HOME/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.model.json" \
  --groups "$HOME/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.groups.json" \
  --out "$HOME/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.html"
```

6. HTML を開く。`cursor-app-control` の `open_resource` に `file://` + HTML の絶対パスを渡す。チャットだけ返して終わらせない。
7. チャットには次だけ返す。パスはすべて絶対パス。相対パスや `~` は使わない。HTML 本文や JSON 全文は貼らない。

```
HTML: /Users/<name>/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.html
groups: /Users/<name>/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.groups.json
model: /Users/<name>/.cursor/diff-review/YYYY-MM-DD-diff-review-<slug>.model.json
グループ: N / 要改善: N / risk: high=N medium=N low=N
省略 hunk: N
```

## HTML アプリ（`templates/app.html`）

生成 HTML の操作。ここを落とす変更はしない。

### ショートカット

| キー | 動作 |
| --- | --- |
| `j` / `k` | 次 / 前のグループ |
| `J` / `K` | 読む順の次 / 前のファイル |
| `f` | グループ / ファイルタブ |
| `e` | 走査と精読の切り替え |
| `[` | サイドバー開閉 |
| `?` | この解説 |
| 行の `+` | その行にメモ（ホバーで出す） |

### 大きな hunk

- hunk ヘッダー（id / パス / `@@`）は `position: sticky; top: 0`。スクロール中も画面上端に残す
- `.hunk` は `overflow: visible`。sticky を `#main` に効かせる
- `revealHunk` は hunk 全体ではなく `.hunk-head` を上端へ送る

### 行メモ

GitHub の行コメントに寄せる。hunk 末尾とグループのメモは残す。

- 左右ペインそれぞれに `+`。旧は `old`、新は `new`
- クリックでその行の直下に入力欄。幅は `max-width: 36rem`。追加 / キャンセル、⌘Enter で確定、Esc で閉じる
- 付いた行は `·` を出しっぱなし。編集と削除ができる
- `localStorage` の `lineMemos`（キーは `hunkId:side:line`）
- サイドバーのメモ一覧からその行へ飛べる

### 遷移スクロール

- グループ（`j` / `k`、サイドバー、理解カード）とファイル（`J` / `K`、ファイル一覧）は `scrollMainTo(..., { smooth: true })`
- 瞬間移動にしない。ease-out、200〜380ms、上端から 20px 余白
- 連続キーは前のアニメをキャンセルして付け直す
- サイドバー内の追従スクロールは `nearest` のまま

## slug

model.json の `slug` を使う。`null`（detached または既定ブランチ）なら差分内容から短い英語 slug を付ける。

## 兄弟 Skill

- `explain-diff-html`: 教育（Background / Intuition / Quiz）
- 本 Skill: レビュー（意図グループ、指摘、確認、メモ）
