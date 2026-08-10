# Knowledge Alchemy Pilot

児童向け図書探索支援システム Knowledge Alchemy のパイロットスタディ用UIです。

## ファイル構成

```text
knowledge-alchemy-pilot/
├─ index.html
├─ styles.css
├─ data.js
├─ app.js
├─ .nojekyll
├─ .gitignore
├─ assets/
│  └─ background_common.png
└─ data/
   └─ kids_history_success.json
```

- `index.html`：画面の構造
- `styles.css`：レイアウト、文字サイズ、スマートフォン対応、アニメーション
- `data.js`：NDC分類名、関係名、JSON読込先
- `app.js`：図書データ読込、検索、関連本表示、詳細表示、探索、事後質問、ログ記録
- `assets/background_common.png`：共通背景
- `data/kids_history_success.json`：児童書データ

## 現在の動作

1. `kids_history_success.json` を読み込む
2. 実験開始前に匿名の参加者IDを入力する
3. 児童が気になることを入力する
4. 入口となる1冊を表示する
5. 題名、ぴったり度、本の手がかりになることば、NDC本棚案内を順に表示する
6. 固定テンプレートと構造化データによる案内文を表示する
7. 関連本を4冊、時間差で1冊ずつ表示する
8. 本の情報を確認し、必要に応じて別の本を新しい中心にする
9. 探索途中では「入口の本にもどる」を選べる
10. 最後に借りたい本を選び、短い事後質問に回答する
11. 本棚案内を表示し、操作ログをJSONで保存する

## 図書データ

`data/kids_history_success.json` の ISBN、書名、NDC、subjects を実際に画面へ読み込みます。

現在の静的版では FastAPI / SBERT をまだ接続していないため、入口本の選択は書名・subjects と入力文の文字列の近さから求める簡易検索です。関連本は、次の順序を重視して決めます。

- subjects が一致する本
- NDCの上位分類が同じ本
- 書名・subjects の文字列が近い本

この簡易一致度はSBERTのcosine similarityではありません。操作画面と実データの組合せを確認するための一時的な処理です。FastAPI / SBERT 接続後は、`startSearch()` の入口本選択と関連本決定部分をバックエンドの結果に置き換えます。

現在の28冊に近い本がない入力については、関係のない本を無理に表示せず、別の言葉を入力する案内を出します。

動作確認には、次のような語を利用できます。

- アイヌ
- iPS細胞
- アインシュタイン
- 美術
- ニュートン

## 案内文

本実験では自由生成LLMを使用しません。

案内文は、関係種類に対応した固定テンプレートへ、subjects、NDC分類、利用可能な場合はRDF三つ組などの構造化データを差し込んで表示します。

現在の `kids_history_success.json` にはRDF三つ組が含まれていないため、この静的版ではsubjectsとNDCを中心に案内します。今後 `rdf_triples` をデータへ追加した場合は、同じ固定テンプレート方式で利用できます。

## 操作ログ

主なイベントは次のとおりです。

- `experiment_start`
- `search_start`
- `search_no_match`
- `initial_recommendation`
- `fit_score_displayed`
- `displayed_nodes`
- `preview_event`
- `detail_event`
- `expand_from_book`
- `return_to_initial_book`
- `final_choice`
- `post_reflection_answer`
- `study_complete`

各イベントには `participant_id`、`session_id`、`timestamp` を記録します。検索開始後のイベントには `original_input` も記録されます。

静的版の `initial_recommendation` には `match_method: "local_text_match"` と `initial_match_score` を保存します。FastAPI / SBERT 接続後は、ここを実際の検索方式とcosine similarityへ置き換えます。

## 背景表示

背景は `assets/background_common.png` を `object-fit: contain` で表示し、画像全体ができるだけ切れずに見えるようにしています。画面比率が画像と異なる場合は、周囲を海色の背景で補います。

## ローカルでの起動

JSONを `fetch()` で読み込むため、`index.html` を直接ダブルクリックするのではなく、HTTPサーバー経由で開きます。

例：

```bash
python -m http.server 8000
```

その後、ブラウザで次を開きます。

```text
http://localhost:8000/
```

VS Code の Live Server や GitHub Pages でも動作します。
