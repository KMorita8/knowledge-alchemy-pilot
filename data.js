// ============================================================
// data.js
// 画面表示に使う分類名・関係名・図書データの読込先をまとめる。
// 図書本体は data/kids_history_success.json から読み込む。
// ============================================================

const DATASET_URL = 'data/kids_history_success.json';

const relationDisplay = {
  shared_subject: 'おなじテーマ',
  shared_ndc: 'おなじ分野',
  concept_path: 'ことばでつながる',
  local_text_match: 'ことばが近い',
  semantic_similarity: 'いみが近い'
};

const ndcData = [
  { n: 0, icon: '📚', label: '<ruby>総記<rt>そうき</rt></ruby>', child: 'しらべる' },
  { n: 1, icon: '💭', label: '<ruby>哲学<rt>てつがく</rt></ruby>', child: 'こころ' },
  { n: 2, icon: '🏯', label: '<ruby>歴史<rt>れきし</rt></ruby>', child: 'むかし' },
  { n: 3, icon: '👥', label: '<ruby>社会科学<rt>しゃかいかがく</rt></ruby>', child: 'くらし' },
  { n: 4, icon: '🔬', label: '<ruby>自然科学<rt>しぜんかがく</rt></ruby>', child: 'しぜん' },
  { n: 5, icon: '⚙️', label: '<ruby>技術<rt>ぎじゅつ</rt></ruby>', child: 'ものづくり' },
  { n: 6, icon: '🌾', label: '<ruby>産業<rt>さんぎょう</rt></ruby>', child: 'しごと' },
  { n: 7, icon: '🎨', label: '<ruby>芸術<rt>げいじゅつ</rt></ruby>', child: 'げいじゅつ' },
  { n: 8, icon: '💬', label: '<ruby>言語<rt>げんご</rt></ruby>', child: 'ことば' },
  { n: 9, icon: '📖', label: '<ruby>文学<rt>ぶんがく</rt></ruby>', child: 'ものがたり' }
];

// JSON読込後に app.js から設定する。
let books = {};
let bookList = [];
let semanticMeta = {};
