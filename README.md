# diff-review-html

大きな git 差分を意図ごとのグループに分け、単一の HTML で読む Cursor Agent Skill です。

Agent Plugins 形式です。Cursor Marketplace 提出用です。

## Install

Marketplace 掲載後は、Cursor の Customize から `diff-review-html` を Install します。

掲載前の確認、または Marketplace を使わない場合:

1. このリポジトリを `~/.cursor/plugins/local/diff-review-html` に置く
2. Cursor を再起動する（または Reload Window）
3. Customize に `diff-review-html` が出るか確認する
4. チャットで `/diff-review-html` を実行する

```bash
git clone https://github.com/tomoya-kamaji/diff-review-html.git ~/.cursor/plugins/local/diff-review-html
```

## Usage

対象リポジトリを開いた状態で `/diff-review-html` を呼びます。

成果物は `$HOME/.cursor/diff-review/` に出ます。

## Layout

```text
plugin.json
skills/diff-review-html/
  SKILL.md
  scripts/
  templates/
  reference/
```

スクリプトは `SKILL.md` と同じフォルダをルートにします。インストール先に依存しません。

## Publish

1. このリポジトリが public であること
2. [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) にリポジトリ URL を出す
3. Cursor チームの手動審査を待つ

掲載は保証されません。更新も Git push だけでは反映されず、再審査です。

## License

MIT
