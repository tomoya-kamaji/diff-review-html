# groups.json スキーマ

AI が書く入力。HTML は書かない。`build-review.mjs` が model.json と結合して検証する。

## 形

```json
{
  "version": 1,
  "title": "レビュー全体のタイトル（1 行）",
  "summary": "変更全体の要約 2〜4 文",
  "problem": "解いている問題（1〜2 文）",
  "core": "g01",
  "doneWhen": "確認できたらレビューを終えてよい条件（1 文）",
  "groups": [
    {
      "id": "g01",
      "title": "グループ名",
      "intent": "このグループの意図（必須、1〜3 文）",
      "kind": "refactor|feat|fix|test|docs|chore|generated",
      "risk": "high|medium|low",
      "riskReason": "signals と食い違う場合は必須",
      "hunkIds": ["h001"],
      "seedIds": ["s001"],
      "annotations": [
        { "goal": "判定の入口", "hunkId": "h001" }
      ],
      "findings": [
        {
          "type": "improve|unclear|note",
          "hunkId": "h012",
          "line": 23,
          "side": "new|old",
          "text": "指摘または解説"
        }
      ]
    }
  ]
}
```

## ルール

- すべての hunk がちょうど 1 グループに所属する（未所属・重複は検証エラー）
- seed は丸ごと 1 グループへ入れる。結合は可、分割は不可
- 並び順は読む順: 基盤 → 依存側 → テスト → docs。generated は末尾
- `improve` と `unclear` が UI の「要改善」。解説は必要な hunk だけ `note`
- `kind` / `risk` / finding `type` は列挙値のみ
- `title` と `intent` は空文字不可。`hunkIds` と `seedIds` を合わせて 1 件以上
- `seedIds` に書いた seed の hunk は `hunkIds` に自動展開される。seed 単位で書き、seed 外の hunk だけ `hunkIds` に列挙すればよい
- finding の `hunkId` は model に実在。`line` を書くならその hunk の行範囲内
- 所属 hunk / file の signals 最大 level より低い `risk` には `riskReason` が必須
- `problem` / `core` / `doneWhen` は必須。`core` は存在する `groups[].id`
- `annotations` は任意。書くなら `goal` は空不可。`hunkId` はそのグループ所属

## 本文のない hunk

`meta` が付いた hunk（`rename-only` / `binary` / `empty`）も、どこかのグループに必ず入れる。本文は空なので finding の `line` は付けない。

## フィールド

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| version | はい | 常に `1` |
| title | はい | 俯瞰ヘッダーのタイトル |
| summary | はい | 理解カードの狙い |
| problem | はい | 理解カードの問題 |
| core | はい | 核のグループ ID |
| doneWhen | はい | 理解カードの完了条件 |
| groups[].id | はい | `g01` 形式を推奨 |
| groups[].intent | はい | グループの意図 |
| groups[].seedIds | いいえ | 結合した seed の ID。所属 hunk は自動展開 |
| groups[].annotations | いいえ | 意図と hunk の対応。走査の hunk 行と、開いた hunk の中身に出す |
| findings[].line / side | いいえ | note / unclear は該当行の右。improve は差分の直下 |
