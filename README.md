# kisekae3 — 実物写真ベースの着せ替えアプリ

キャラと服の画像を組み合わせ、初回はComfyUIで画像を生成し、生成済みなら表示するアプリです。

## 実行

```
npm start        # node server.js → http://localhost:3000
```

依存パッケージなし（Node 18+ の標準機能のみ）。

## データ構成（すべてフォルダの中身から自動でカタログ化）

```
store/
  characters/<charId>/icon.(png|jpg|jpeg|webp|gif|svg)   ← キャラ（後から追加すれば候補に出る）
  clothes/<dressId>.<ext>                                 ← 服（後から追加すれば候補に出る）
  generated/<charId>/<dressId>.<ext>                     ← 既存の生成結果（手動生成済み分もここ）
  generated/<charId>/<dressId>__<日時>-<ID>.<ext>         ← 再生成したバージョン
```

- キャラ名/服名はフォルダ名・ファイル名（base name）がそのまま使われます。
- 既存の `images/` は参考用としてアプリからは読みません（data.js は削除済み）。

## 動作

キャラ一覧 → キャラ画面 → 服を選ぶと:

1. `store/generated/<char>/<dress>` にファイルがあればそれを表示
2. なければComfyUIで生成し、結果を保存して表示（UIは4秒ごとに再スキャンなので、
   手動で画像を置いても次回リフレッシュで「生成済み」になります）
3. プロンプト欄とシード欄を編集すると、その内容で生成します。シード欄の「ランダム」ボタンで新しいシードに変更できます。生成済みの服は「選択中を再生成」で新しいバージョンを追加します。複数ある場合は画像下の選択欄から表示を切り替えられます。

API:

- `GET /api/catalog` — キャラ・服・生成済みマップ
- `GET /api/config` — ワークフローJSONに設定された既定プロンプト
- `POST /api/generate {character, dress, prompt, seed, force}` — 既存なら `{status:"existing"}`, なければ生成。`seed` は省略可能な0以上の安全な整数。`force: true` は既存結果を残したまま新しいバージョンを生成

## ComfyUI

ComfyUIを起動し、ワークフローが参照するモデルとカスタムノードをインストールしてください。
既定ではルートの `image_flux2_klein_image_edit_9b_distilled.json` を読み込みます。
ワークフロー内のサブグラフをComfyUI API形式に展開し、キャラ画像・服画像を入力して実行します。
生成画像は `store/generated/<char>/<dress>__<日時>-<ID>.png` に保存され、以前の画像も残ります。従来の `<dress>.<ext>` 形式の画像も引き続き表示されます。

- `COMFYUI_URL` — ComfyUI URL（既定値 `http://127.0.0.1:8188`）
- `COMFYUI_WORKFLOW` — 別のワークフローJSONを使う場合のファイルパス
- `COMFYUI_TIMEOUT_MS` — 生成待ちのタイムアウト（既定値10分）
- `GENERATOR=mock` — ComfyUIを使わずプレースホルダー画像を生成する開発用モード

ComfyUIが起動していない、モデルが不足している、またはワークフローに問題がある場合は、
画面に生成エラーが表示されます。
