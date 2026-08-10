// ============================================================
// app.js
// 児童の操作、画面遷移、図書データの読込、ログ記録をまとめる。
// ============================================================

const RELATED_BOOK_COUNT = 4;

const UX_TIMING = {
  searchMagic: 2300,
  relatedWarmup: 2300,
  relatedGap: 1650,
  afterRelated: 1300
};

const state = {
  participant_id: '',
  session_id: '',
  original_input: '',
  initial_book_id: null,
  initial_match_score: null,
  match_method: 'local_text_match',
  centerBookId: null,
  path: [],
  finalBookId: null,
  logs: [],
  surveyAnswers: {},
  previewHistory: [],
  revealToken: 0
};

let datasetReady = false;
let dialogueResolver = null;
let surveyIndex = 0;

const el = id => document.getElementById(id);


// ------------------------------------------------------------
// 1. 図書データの読込と整形
// ------------------------------------------------------------

// 比較用に、全角半角・空白・記号の違いを減らす。
function normalizeText(text = '') {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・:：,，.。!！?？「」『』（）()\-―ー_/／]/g, '');
}

// 文字列を2文字ずつに分ける。
// FastAPI/SBERT接続前のローカル検索でだけ使う。
function makeBigrams(text) {
  const value = normalizeText(text);
  if (value.length < 2) return value ? [value] : [];

  const result = [];
  for (let i = 0; i < value.length - 1; i++) {
    result.push(value.slice(i, i + 2));
  }
  return result;
}

// 2文字の重なりから0～1の簡易一致度を求める。
function diceScore(textA, textB) {
  const a = makeBigrams(textA);
  const b = makeBigrams(textB);

  if (!a.length || !b.length) return 0;

  const counts = new Map();
  a.forEach(item => counts.set(item, (counts.get(item) || 0) + 1));

  let common = 0;
  b.forEach(item => {
    const count = counts.get(item) || 0;
    if (count > 0) {
      common++;
      counts.set(item, count - 1);
    }
  });

  return (2 * common) / (a.length + b.length);
}

function makeBookId(record, index) {
  const isbn = String(record.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return isbn ? `ISBN_${isbn}` : `BOOK_${String(index + 1).padStart(3, '0')}`;
}

// JSONの1件を、画面で扱いやすい形へそろえる。
function prepareBook(record, index) {
  const subjects = Array.isArray(record.subjects)
    ? record.subjects.filter(Boolean).map(String)
    : [];

  const ndc = String(record.ndc || '0');
  const title = String(record.title || 'タイトル不明');
  const isbn = String(record.isbn || '');

  return {
    id: makeBookId(record, index),
    isbn,
    title,
    titleHtml: escapeHtml(title),
    ndc,
    subjects,
    triples: Array.isArray(record.rdf_triples) ? record.rdf_triples : [],
    cover_url: record.cover_url || '',
    related: [],
    relationMap: {},
    similarity: null
  };
}

function subjectKey(subject) {
  return normalizeText(subject);
}

function commonSubjects(bookA, bookB) {
  const setA = new Set(bookA.subjects.map(subjectKey));
  return bookB.subjects.filter(subject => setA.has(subjectKey(subject)));
}

function bookText(book) {
  return [book.title, ...book.subjects].join(' ');
}

// 2冊の関係を、現在のJSONで確認できる情報から決める。
// RDF三つ組が追加された場合は concept_path も利用できる。
function relationBetween(bookA, bookB) {
  const shared = commonSubjects(bookA, bookB);
  if (shared.length > 0) return 'shared_subject';

  if (ndcTopNumber(bookA) === ndcTopNumber(bookB)) {
    return 'shared_ndc';
  }

  return 'local_text_match';
}

// 関連本の並び順を決めるためのローカル用スコア。
// 本実験のSBERT類似度とは別物で、静的画面の確認にだけ使う。
function relatedScore(bookA, bookB) {
  const sharedCount = commonSubjects(bookA, bookB).length;
  const sameTopNdc = ndcTopNumber(bookA) === ndcTopNumber(bookB) ? 1 : 0;
  const sameNdc = String(bookA.ndc) === String(bookB.ndc) ? 1 : 0;
  const textScore = diceScore(bookText(bookA), bookText(bookB));

  return sharedCount * 10 + sameNdc * 4 + sameTopNdc * 2 + textScore * 5;
}

// 全冊について「次に出す候補」をあらかじめ作る。
function buildRelatedBooks() {
  bookList.forEach(centerBook => {
    const ranked = bookList
      .filter(book => book.id !== centerBook.id)
      .map(book => ({
        id: book.id,
        score: relatedScore(centerBook, book),
        relation: relationBetween(centerBook, book)
      }))
      .sort((a, b) => b.score - a.score);

    centerBook.related = ranked.slice(0, 8).map(item => item.id);
    centerBook.relationMap = {};

    ranked.slice(0, 8).forEach(item => {
      centerBook.relationMap[item.id] = item.relation;
    });
  });
}

function setDatasetStatus(message, isError = false) {
  const status = el('datasetStatus');
  if (!status) return;

  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function loadBookDataset() {
  try {
    const response = await fetch(DATASET_URL, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const records = await response.json();

    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('図書データが空です');
    }

    bookList = records.map(prepareBook);
    books = Object.fromEntries(bookList.map(book => [book.id, book]));
    semanticMeta = Object.fromEntries(
      bookList.map(book => [
        book.id,
        {
          subjects: book.subjects.map(escapeHtml),
          triples: book.triples.map(triple => triple.map(item => escapeHtml(String(item))))
        }
      ])
    );

    buildRelatedBooks();

    datasetReady = true;
    el('startExperimentButton').disabled = false;
    setDatasetStatus(`図書データ ${bookList.length}冊を読み込みました。`);
  } catch (error) {
    console.error('dataset load error', error);
    datasetReady = false;
    el('startExperimentButton').disabled = true;
    setDatasetStatus(
      '図書データを読み込めませんでした。GitHub Pages、Live Server、またはローカルHTTPサーバーで開いてください。',
      true
    );
  }
}


// ------------------------------------------------------------
// 2. ローカル検索
// ------------------------------------------------------------

function scoreBookForQuery(book, query) {
  const q = normalizeText(query);
  const title = normalizeText(book.title);
  const subjectValues = book.subjects.map(normalizeText).filter(Boolean);

  if (!q) return 0;

  let score = diceScore(query, book.title) * 0.72;

  if (title.includes(q) || q.includes(title)) {
    score = Math.max(score, 0.98);
  }

  subjectValues.forEach(subject => {
    if (!subject) return;

    if (q.includes(subject) || subject.includes(q)) {
      score = Math.max(score, 0.94);
    } else {
      score = Math.max(score, diceScore(query, subject) * 0.82);
    }
  });

  return Math.min(1, score);
}

function findEntryBook(query) {
  const ranked = bookList
    .map(book => ({ book, score: scoreBookForQuery(book, query) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  // 28冊の中に手がかりがほぼ無い時は、関係のない本を無理に出さない。
  if (!best || best.score < 0.18) return null;

  best.book.similarity = best.score;
  return best.book;
}

function relationFor(centerId, targetId) {
  return books[centerId]?.relationMap?.[targetId] || 'local_text_match';
}


// ------------------------------------------------------------
// 3. 実験開始と状態管理
// ------------------------------------------------------------

function resetSession(participantId) {
  state.participant_id = participantId;
  state.session_id = 'S_' + Date.now();
  state.original_input = '';
  state.initial_book_id = null;
  state.initial_match_score = null;
  state.centerBookId = null;
  state.path = [];
  state.finalBookId = null;
  state.logs = [];
  state.surveyAnswers = {};
  state.previewHistory = [];
  state.revealToken++;

  el('graph').innerHTML = '';
  el('queryInput').readOnly = false;
  el('searchButton').disabled = false;

  renderJourney();
  setStep(1);
  setFocus('search');
  setGuide(
    '<ruby>気<rt>き</rt></ruby>になることを、そのまま<ruby>入<rt>い</rt></ruby>れてみよう。',
    '<ruby>白<rt>しろ</rt></ruby>い<ruby>入力欄<rt>にゅうりょくらん</rt></ruby>に<ruby>書<rt>か</rt></ruby>いて「<ruby>探<rt>さが</rt></ruby>してみる！」'
  );
}

function startExperiment() {
  if (!datasetReady) return;

  const participantId = el('participantInput').value.trim();
  if (!participantId) {
    el('participantInput').focus();
    return;
  }

  resetSession(participantId);
  el('experimentStartModal').classList.remove('open');
  logEvent('experiment_start');
  el('queryInput').focus();
}


// ------------------------------------------------------------
// 4. 共通の画面操作
// ------------------------------------------------------------

function setStep(step) {
  document.querySelectorAll('.step-item').forEach(item => {
    const number = Number(item.dataset.step);
    item.classList.toggle('active', number === step);
    item.classList.toggle('done', number < step);
  });
}

function setGuide(messageHtml, hintHtml = '') {
  el('speechText').innerHTML = messageHtml;
  el('guideMessage').innerHTML =
    hintHtml ||
    '<ruby>下<rt>した</rt></ruby>のフクロウの<ruby>案内<rt>あんない</rt></ruby>を<ruby>見<rt>み</rt></ruby>てね。';

  el('nextHint').style.display = 'none';
  el('speechNext').classList.remove('show');
  el('speech').classList.remove('tap-ready');
}

function guideStep(messageHtml, hintHtml = '') {
  setGuide(messageHtml, hintHtml);

  return new Promise(resolve => {
    dialogueResolver = resolve;
    el('speechNext').classList.add('show');
    el('speech').classList.add('tap-ready');
  });
}

function continueDialogue() {
  if (!dialogueResolver) return;

  const resolve = dialogueResolver;
  dialogueResolver = null;

  el('speechNext').classList.remove('show');
  el('speech').classList.remove('tap-ready');
  resolve();
}

function setFocus(mode) {
  document.body.classList.remove(
    'focus-search',
    'focus-center',
    'focus-candidates',
    'focus-preview'
  );

  if (mode) document.body.classList.add('focus-' + mode);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function plainTextFromHtml(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}


// ------------------------------------------------------------
// 5. 操作ログ
// ------------------------------------------------------------

function logEvent(eventType, extra = {}) {
  const record = {
    participant_id: state.participant_id,
    session_id: state.session_id,
    original_input: state.original_input,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    ...extra
  };

  state.logs.push(record);
  console.log('[research-log]', record);
}

function downloadLog() {
  const json = JSON.stringify(state.logs, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `knowledge_alchemy_${state.participant_id}_${state.session_id}.json`;
  link.click();

  URL.revokeObjectURL(url);
}


// ------------------------------------------------------------
// 6. NDC・歩いた道・書影
// ------------------------------------------------------------

function ndcTopNumber(book) {
  const raw = String(book.ndc ?? '');
  const number = parseInt(raw.charAt(0), 10);
  return Number.isFinite(number) ? number : 0;
}

function ndcInfo(book) {
  const number = ndcTopNumber(book);
  return ndcData.find(item => item.n === number) || ndcData[0];
}

function renderJourney() {
  const panel = el('journeyPanel');
  const trail = el('journeyTrail');
  const returnButton = el('returnToStartButton');

  if (state.path.length < 2) {
    panel.hidden = true;
    trail.innerHTML = '';
    returnButton.hidden = true;
    return;
  }

  panel.hidden = false;
  trail.innerHTML = '';

  state.path.forEach((id, index) => {
    if (index > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'journey-arrow';
      arrow.textContent = '➡';
      trail.appendChild(arrow);
    }

    const book = books[id];
    if (!book) return;

    const step = document.createElement('span');
    step.className =
      'journey-step' +
      (index === state.path.length - 1 ? ' current' : '');
    step.textContent = book.title;
    trail.appendChild(step);
  });

  returnButton.hidden = state.centerBookId === state.initial_book_id;
}

function coverHtml(book) {
  return `
    <div class="cover" data-book="${book.id}">
      <span class="cover-fallback" aria-hidden="true"></span>
      <img alt="${escapeHtml(book.title)}の書影">
    </div>
  `;
}

function trySetCover(container, book) {
  if (!book.cover_url) return;

  const cover = container.querySelector('.cover');
  const image = cover?.querySelector('img');
  if (!cover || !image) return;

  image.onload = () => cover.classList.add('has-image');
  image.onerror = () => cover.classList.remove('has-image');
  image.src = book.cover_url;
}

function subjectChipsHtml(book) {
  const subjects = book.subjects.length
    ? book.subjects
    : [plainTextFromHtml(ndcInfo(book).label)];

  return subjects
    .slice(0, 4)
    .map(subject => `<span class="subject-chip">${escapeHtml(subject)}</span>`)
    .join('');
}

function shelfInfoHtml(book, compact = false) {
  const ndc = ndcInfo(book);
  const label = `${ndc.n}<ruby>類<rt>るい</rt></ruby> ${ndc.label}`;

  if (compact) {
    return `<span class="candidate-shelf">📚 ${label}</span>`;
  }

  return `
    <div class="shelf-info">
      <span class="shelf-icon">📚</span>
      <span>
        この<ruby>本<rt>ほん</rt></ruby>は
        <strong>${label}</strong> の<ruby>本棚<rt>ほんだな</rt></ruby>
      </span>
    </div>
  `;
}


// ------------------------------------------------------------
// 7. 本カードのHTML
// ------------------------------------------------------------

function centerCardHtml(book, isEntry) {
  const fitScore =
    isEntry && typeof book.similarity === 'number'
      ? Math.round(book.similarity * 100)
      : null;

  return `
    <article class="book-card center">
      <div class="book-body">
        ${coverHtml(book)}
        <div>
          <p class="book-title">${book.titleHtml}</p>
          <span class="book-tag">
            ${
              isEntry
                ? '✦ <ruby>入口<rt>いりぐち</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>'
                : '● いまの<ruby>中心<rt>ちゅうしん</rt></ruby>'
            }
          </span>
        </div>
      </div>

      ${
        fitScore !== null
          ? `
            <div id="centerFitStage" class="center-stage fit-stage" style="--fit-score:${fitScore}%">
              <div class="fit-card">
                <div class="fit-burst">
                  <span class="fit-label">ことばとの<br>ぴったり<ruby>度<rt>ど</rt></ruby></span>
                  <span class="fit-number">${fitScore}</span>
                  <span class="fit-unit">%</span>
                </div>
                <div>
                  <div class="fit-track"><div class="fit-fill"></div></div>
                  <div class="fit-note">ことばとの<ruby>近<rt>ちか</rt></ruby>さの<ruby>目安<rt>めやす</rt></ruby></div>
                </div>
              </div>
            </div>
          `
          : ''
      }

      <div id="centerSubjectStage" class="center-stage subject-stage">
        <div class="subject-kicker">
          この<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりになることば
        </div>
        <div class="subject-list">${subjectChipsHtml(book)}</div>
        ${shelfInfoHtml(book)}
      </div>

      <div id="centerActions" class="center-actions">
        <button class="btn info" type="button" data-action="detail">
          <ruby>詳<rt>くわ</rt></ruby>しく<ruby>見<rt>み</rt></ruby>る
        </button>
        <button class="btn gold" type="button" data-action="final">
          これをかりたい！
        </button>
        <button class="btn main-next" type="button" data-action="related">
          ✦ この<ruby>本<rt>ほん</rt></ruby>から、つながる<ruby>本<rt>ほん</rt></ruby>を<ruby>見<rt>み</rt></ruby>る！
        </button>
      </div>
    </article>
  `;
}

function candidatePreviewHtml(book) {
  const subjects = book.subjects.length
    ? book.subjects.slice(0, 3).map(escapeHtml).join('・')
    : '手がかりのことばは登録されていません';

  return `
    <strong><ruby>手<rt>て</rt></ruby>がかり：</strong>${subjects}<br>
    <strong>NDC：</strong>${escapeHtml(book.ndc)}
  `;
}

function candidateHtml(book, relationType) {
  return `
    <article class="book-card candidate-card">
      <div class="book-body">
        ${coverHtml(book)}
        <div>
          <p class="book-title">${book.titleHtml}</p>
          ${shelfInfoHtml(book, true)}
          <span class="relation-tag">${relationDisplay[relationType] || 'つながる本'}</span>
        </div>
      </div>

      <div class="preview">
        <p>${candidatePreviewHtml(book)}</p>
        <div class="preview-actions">
          <button class="mini-btn detail" type="button" data-caction="detail">
            <ruby>詳<rt>くわ</rt></ruby>しく<ruby>見<rt>み</rt></ruby>る
          </button>
          <button class="mini-btn final" type="button" data-caction="final">
            これをかりたい！
          </button>
          <button class="mini-btn expand" type="button" data-caction="expand">
            ✨ この<ruby>本<rt>ほん</rt></ruby>からもっと<ruby>探<rt>さが</rt></ruby>す
          </button>
        </div>
      </div>
    </article>
  `;
}


// ------------------------------------------------------------
// 8. 固定テンプレートによる案内文
// ------------------------------------------------------------

function makeGuideExplanation(book, relationType = 'initial') {
  const subjects = book.subjects || [];
  const firstSubject = subjects[0] || plainTextFromHtml(ndcInfo(book).label);
  const ndc = ndcInfo(book);
  const triple = book.triples?.[0];

  let relationSentence = '';

  if (relationType === 'shared_subject') {
    relationSentence =
      `この<ruby>本<rt>ほん</rt></ruby>は「${escapeHtml(firstSubject)}」という` +
      `おなじテーマでつながっているよ。`;
  } else if (relationType === 'shared_ndc') {
    relationSentence =
      `この<ruby>本<rt>ほん</rt></ruby>は、` +
      `<strong>${ndc.n}<ruby>類<rt>るい</rt></ruby> ${ndc.label}</strong>` +
      `というおなじ<ruby>分野<rt>ぶんや</rt></ruby>からたどれるよ。`;
  } else if (relationType === 'concept_path' && triple) {
    relationSentence =
      `この<ruby>本<rt>ほん</rt></ruby>は、` +
      `「${escapeHtml(triple[0])}」→「${escapeHtml(triple[1])}」→「${escapeHtml(triple[2])}」` +
      `ということばのつながりからたどれるよ。`;
  } else if (relationType === 'local_text_match' || relationType === 'semantic_similarity') {
    relationSentence =
      `この<ruby>本<rt>ほん</rt></ruby>は、` +
      `<ruby>題名<rt>だいめい</rt></ruby>や<ruby>手<rt>て</rt></ruby>がかりのことばが、` +
      `いま<ruby>見<rt>み</rt></ruby>ていた<ruby>本<rt>ほん</rt></ruby>と<ruby>近<rt>ちか</rt></ruby>いよ。`;
  } else {
    relationSentence =
      `「${escapeHtml(state.original_input)}」から、この<ruby>本<rt>ほん</rt></ruby>が<ruby>入口<rt>いりぐち</rt></ruby>になったよ。`;
  }

  const subjectText = subjects.length
    ? ` <ruby>手<rt>て</rt></ruby>がかりのことばは「${subjects.slice(0, 3).map(escapeHtml).join('・')}」だよ。`
    : '';

  return relationSentence + subjectText;
}


// ------------------------------------------------------------
// 9. 中央の本を段階的に見せる
// ------------------------------------------------------------

async function presentCenterSequence(book, isEntry = false, relationType = 'initial') {
  const fitStage = el('centerFitStage');
  const subjectStage = el('centerSubjectStage');
  const actions = el('centerActions');

  if (!subjectStage || !actions) return;

  setFocus('center');

  await guideStep(
    `まずは<ruby>題名<rt>だいめい</rt></ruby>を<ruby>見<rt>み</rt></ruby>てみよう。<br>「${book.titleHtml}」`,
    '<ruby>読<rt>よ</rt></ruby>めたら、<strong>「つぎへ ▼」</strong>をおしてね'
  );

  if (fitStage) {
    fitStage.classList.add('visible');
    spawnSparkles(14);

    const fitValue = Math.round(book.similarity * 100);

    logEvent('fit_score_displayed', {
      book_id: book.id,
      fit_score: fitValue,
      match_method: state.match_method
    });

    await guideStep(
      `おっ！ きみのことばと、この<ruby>本<rt>ほん</rt></ruby>の「ぴったり<ruby>度<rt>ど</rt></ruby>」は <strong>${fitValue}%</strong>！<br>` +
      `<small>これは<ruby>正解<rt>せいかい</rt></ruby>の<ruby>点数<rt>てんすう</rt></ruby>ではなく、ことばの<ruby>近<rt>ちか</rt></ruby>さの<ruby>目安<rt>めやす</rt></ruby>だよ。</small>`,
      '<ruby>見<rt>み</rt></ruby>おわったら「つぎへ ▼」'
    );
  }

  subjectStage.classList.add('visible');
  spawnSparkles(10);

  const shelf = ndcInfo(book);

  await guideStep(
    `<ruby>次<rt>つぎ</rt></ruby>は、この<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりを<ruby>見<rt>み</rt></ruby>てみよう！<br>` +
    `この<ruby>本<rt>ほん</rt></ruby>には、こんな「<ruby>手<rt>て</rt></ruby>がかりのことば」がついているよ。<br>` +
    `<ruby>図書館<rt>としょかん</rt></ruby>では、<strong>${shelf.n}<ruby>類<rt>るい</rt></ruby> ${shelf.label}</strong> の<ruby>本棚<rt>ほんだな</rt></ruby>を<ruby>探<rt>さが</rt></ruby>してみよう！`,
    '<ruby>気<rt>き</rt></ruby>になることばを1つ<ruby>見<rt>み</rt></ruby>つけたら「つぎへ ▼」'
  );

  const explanation = makeGuideExplanation(book, relationType);
  spawnSparkles(12);

  await guideStep(
    explanation,
    '<ruby>案内人<rt>あんないにん</rt></ruby>の<ruby>話<rt>はなし</rt></ruby>を<ruby>読<rt>よ</rt></ruby>んだら「つぎへ ▼」'
  );

  actions.classList.add('visible');

  setGuide(
    '<ruby>気<rt>き</rt></ruby>になった？ ここからは、きみが<ruby>次<rt>つぎ</rt></ruby>をえらべるよ！',
    '<ruby>中央<rt>ちゅうおう</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>のボタンを1つえらんでね'
  );
}

function showCenter(book, isEntry = false, relationType = 'initial') {
  const graph = el('graph');

  graph.innerHTML =
    `<div id="centerNode" class="center-node">${centerCardHtml(book, isEntry)}</div>`;

  const center = el('centerNode');
  trySetCover(center, book);

  center.querySelector('[data-action="detail"]').onclick =
    () => openDetail(book.id, relationType);

  center.querySelector('[data-action="final"]').onclick =
    () => askFinal(book.id);

  center.querySelector('[data-action="related"]').onclick =
    () => revealRelated(book.id);

  renderJourney();
  drawConnections([]);
  presentCenterSequence(book, isEntry, relationType);
}


// ------------------------------------------------------------
// 10. 検索開始
// ------------------------------------------------------------

function startSearch() {
  const query = el('queryInput').value.trim();

  if (!query) {
    el('queryInput').focus();
    setFocus('search');
    setGuide(
      '<ruby>気<rt>き</rt></ruby>になることを、ひとことでもいいから<ruby>入<rt>い</rt></ruby>れてみてね。',
      '<ruby>入力<rt>にゅうりょく</rt></ruby>してから「<ruby>探<rt>さが</rt></ruby>してみる！」'
    );
    return;
  }

  if (!datasetReady) {
    setGuide(
      '<ruby>本<rt>ほん</rt></ruby>のデータをまだ<ruby>読<rt>よ</rt></ruby>み<ruby>込<rt>こ</rt></ruby>めていないよ。',
      '<ruby>実験者<rt>じっけんしゃ</rt></ruby>に<ruby>声<rt>こえ</rt></ruby>をかけてね'
    );
    return;
  }

  state.original_input = query;

  el('searchButton').disabled = true;
  el('queryInput').readOnly = true;
  el('graph').innerHTML = '';

  renderJourney();
  setStep(2);
  el('loader').classList.add('show');
  setFocus('center');

  setGuide(
    `「${escapeHtml(query)}」から、<ruby>冒険<rt>ぼうけん</rt></ruby>の<ruby>入口<rt>いりぐち</rt></ruby>になる<ruby>本<rt>ほん</rt></ruby>を<ruby>探<rt>さが</rt></ruby>しているよ。`,
    'しゅわわわ…… ちょっとまってね'
  );

  logEvent('search_start');
  spawnSparkles(16);

  setTimeout(() => {
    const entryBook = findEntryBook(query);

    el('loader').classList.remove('show');

    if (!entryBook) {
      el('queryInput').readOnly = false;
      el('searchButton').disabled = false;
      setStep(1);
      setFocus('search');
      setGuide(
        '<ruby>今<rt>いま</rt></ruby>の28<ruby>冊<rt>さつ</rt></ruby>のなかでは、ことばが<ruby>近<rt>ちか</rt></ruby>い<ruby>本<rt>ほん</rt></ruby>を<ruby>見<rt>み</rt></ruby>つけられなかったよ。',
        '「アイヌ」「iPS<ruby>細胞<rt>さいぼう</rt></ruby>」「アインシュタイン」「<ruby>美術<rt>びじゅつ</rt></ruby>」などでもためしてみてね'
      );
      logEvent('search_no_match');
      return;
    }

    state.initial_book_id = entryBook.id;
    state.initial_match_score = entryBook.similarity;
    state.centerBookId = entryBook.id;
    state.path = [entryBook.id];

    logEvent('initial_recommendation', {
      initial_book_id: entryBook.id,
      isbn: entryBook.isbn,
      initial_match_score: entryBook.similarity,
      match_method: state.match_method
    });

    showCenter(entryBook, true, 'initial');
    spawnSparkles(20);
  }, UX_TIMING.searchMagic);
}


// ------------------------------------------------------------
// 11. 関連本を1冊ずつ表示
// ------------------------------------------------------------

async function revealRelated(centerId) {
  setStep(3);
  setFocus('candidates');

  const centerBook = books[centerId];
  const relatedIds = centerBook.related.slice(0, RELATED_BOOK_COUNT);
  const token = ++state.revealToken;
  const graph = el('graph');

  graph.querySelectorAll('.candidate-node').forEach(node => node.remove());
  drawConnections([]);

  const relatedButton = el('centerNode')?.querySelector('[data-action="related"]');

  if (relatedButton) {
    relatedButton.disabled = true;
    relatedButton.innerHTML =
      'しゅわわわ…… <ruby>本<rt>ほん</rt></ruby>を<ruby>探<rt>さが</rt></ruby>し<ruby>中<rt>ちゅう</rt></ruby>';
  }

  setGuide(
    'しゅわわわ……。この<ruby>本<rt>ほん</rt></ruby>からのびる<ruby>道<rt>みち</rt></ruby>を、ゆっくりたどっているよ……。',
    'すぐにぜんぶ<ruby>出<rt>だ</rt></ruby>さないよ。1<ruby>冊<rt>さつ</rt></ruby>ずつ<ruby>見<rt>み</rt></ruby>つけよう'
  );

  spawnSparkles(16);
  await wait(UX_TIMING.relatedWarmup);

  if (token !== state.revealToken) return;

  logEvent('displayed_nodes', {
    center_book_id: centerId,
    displayed_nodes: relatedIds.map(id => ({
      book_id: id,
      isbn: books[id].isbn,
      relation_type: relationFor(centerId, id)
    }))
  });

  const countWords = [
    '1<ruby>冊目<rt>さつめ</rt></ruby>',
    '2<ruby>冊目<rt>さつめ</rt></ruby>',
    '3<ruby>冊目<rt>さつめ</rt></ruby>',
    '4<ruby>冊目<rt>さつめ</rt></ruby>'
  ];

  for (let index = 0; index < relatedIds.length; index++) {
    if (token !== state.revealToken) return;

    const id = relatedIds[index];
    const book = books[id];
    const relationType = relationFor(centerId, id);

    const node = document.createElement('div');
    node.className = 'candidate-node';
    node.dataset.pos = index;
    node.dataset.bookId = id;
    node.dataset.relation = relationType;
    node.innerHTML = candidateHtml(book, relationType);

    graph.appendChild(node);
    trySetCover(node, book);

    node.querySelector('.candidate-card').addEventListener('click', event => {
      if (event.target.closest('button')) return;
      previewBook(id, node, relationType);
    });

    node.querySelector('[data-caction="detail"]').onclick = event => {
      event.stopPropagation();
      openDetail(id, relationType);
    };

    node.querySelector('[data-caction="final"]').onclick = event => {
      event.stopPropagation();
      askFinal(id);
    };

    node.querySelector('[data-caction="expand"]').onclick = event => {
      event.stopPropagation();
      expandFrom(id, relationType);
    };

    await wait(index === 0 ? 650 : UX_TIMING.relatedGap);

    if (token !== state.revealToken) return;

    node.classList.add('show', 'just-arrived');
    drawConnections(relatedIds.slice(0, index + 1));
    spawnSparkles(9);

    setGuide(
      `${countWords[index]}が<ruby>見<rt>み</rt></ruby>つかった！ 「${book.titleHtml}」`,
      'まだ<ruby>次<rt>つぎ</rt></ruby>もあるよ。<ruby>題名<rt>だいめい</rt></ruby>をちょっと<ruby>見<rt>み</rt></ruby>ていてね'
    );

    setTimeout(() => node.classList.remove('just-arrived'), 1100);
  }

  await wait(UX_TIMING.afterRelated);

  if (token !== state.revealToken) return;

  if (relatedButton) relatedButton.style.display = 'none';

  setGuide(
    `${relatedIds.length}<ruby>冊<rt>さつ</rt></ruby>そろったよ！ <ruby>題名<rt>だいめい</rt></ruby>を<ruby>見<rt>み</rt></ruby>て、<ruby>気<rt>き</rt></ruby>になる<ruby>本<rt>ほん</rt></ruby>を1<ruby>冊<rt>さつ</rt></ruby>タップしてみよう。`,
    'いま<ruby>押<rt>お</rt></ruby>せるのは<ruby>本<rt>ほん</rt></ruby>のカードだよ'
  );
}


// ------------------------------------------------------------
// 12. 関連本の短い説明・詳細・中心変更
// ------------------------------------------------------------

function previewBook(id, node, relationType) {
  document.querySelectorAll('.candidate-node').forEach(otherNode => {
    if (otherNode !== node) otherNode.classList.remove('preview-open');
  });

  const open = !node.classList.contains('preview-open');
  node.classList.toggle('preview-open', open);

  if (open) {
    if (!state.previewHistory.includes(id)) state.previewHistory.push(id);

    setFocus('preview');

    logEvent('preview_event', {
      book_id: id,
      isbn: books[id].isbn,
      center_book_id: state.centerBookId,
      relation_type: relationType
    });

    setGuide(
      `「${books[id].titleHtml}」が<ruby>気<rt>き</rt></ruby>になったんだね。<ruby>手<rt>て</rt></ruby>がかりのことばを<ruby>見<rt>み</rt></ruby>てみよう。`,
      'そのあと「<ruby>詳<rt>くわ</rt></ruby>しく」か「この<ruby>本<rt>ほん</rt></ruby>からもっと<ruby>探<rt>さが</rt></ruby>す」をえらべるよ'
    );
  } else {
    setFocus('candidates');
    setGuide(
      '<ruby>気<rt>き</rt></ruby>になる<ruby>本<rt>ほん</rt></ruby>をもう1<ruby>冊<rt>さつ</rt></ruby><ruby>見<rt>み</rt></ruby>てもいいよ。',
      'じぶんのペースでえらんでね'
    );
  }
}

function expandFrom(id, relationType) {
  const fromBookId = state.centerBookId;
  const book = books[id];

  state.revealToken++;
  state.centerBookId = id;
  state.path.push(id);

  if (!state.previewHistory.includes(id)) state.previewHistory.push(id);

  logEvent('expand_from_book', {
    from_book_id: fromBookId,
    to_book_id: id,
    isbn: book.isbn,
    relation_type: relationType
  });

  setStep(3);
  setFocus('center');

  setGuide(
    `いいね！ 「${book.titleHtml}」を<ruby>新<rt>あたら</rt></ruby>しい<ruby>中心<rt>ちゅうしん</rt></ruby>にするよ。`,
    'すぐに<ruby>次<rt>つぎ</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>は<ruby>出<rt>だ</rt></ruby>さないよ。まずこの<ruby>本<rt>ほん</rt></ruby>を<ruby>見<rt>み</rt></ruby>よう'
  );

  showCenter(book, false, relationType);
  spawnSparkles(16);
}

function showCenterQuick(book) {
  const graph = el('graph');

  graph.innerHTML =
    `<div id="centerNode" class="center-node">${centerCardHtml(book, true)}</div>`;

  const center = el('centerNode');
  trySetCover(center, book);

  const fitStage = el('centerFitStage');
  const subjectStage = el('centerSubjectStage');
  const actions = el('centerActions');

  if (fitStage) fitStage.classList.add('visible');
  if (subjectStage) subjectStage.classList.add('visible');
  if (actions) actions.classList.add('visible');

  center.querySelector('[data-action="detail"]').onclick =
    () => openDetail(book.id, 'initial');
  center.querySelector('[data-action="final"]').onclick =
    () => askFinal(book.id);
  center.querySelector('[data-action="related"]').onclick =
    () => revealRelated(book.id);

  renderJourney();
  drawConnections([]);
}

function returnToInitialBook() {
  const initialId = state.initial_book_id;

  if (!initialId || state.centerBookId === initialId) return;

  const fromBookId = state.centerBookId;

  state.revealToken++;
  state.centerBookId = initialId;
  state.path.push(initialId);

  logEvent('return_to_initial_book', {
    from_book_id: fromBookId,
    to_book_id: initialId
  });

  setStep(3);
  setFocus('center');
  showCenterQuick(books[initialId]);
  spawnSparkles(14);

  setGuide(
    `<ruby>入口<rt>いりぐち</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>「${books[initialId].titleHtml}」に<ruby>戻<rt>もど</rt></ruby>ったよ。`,
    'ここからもういちど、つながる<ruby>本<rt>ほん</rt></ruby>を<ruby>見<rt>み</rt></ruby>てもいいよ'
  );
}

function detailDescriptionHtml(book) {
  const subjects = book.subjects.length
    ? book.subjects.slice(0, 5).map(escapeHtml).join('・')
    : '登録なし';

  return `
    <strong>この<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかり</strong><br>
    ${subjects}<br><br>
    <strong>NDC：</strong>${escapeHtml(book.ndc)}<br>
    <strong>ISBN：</strong>${escapeHtml(book.isbn || '登録なし')}
  `;
}

function openDetail(id, relationType = 'initial') {
  const book = books[id];
  const ndc = ndcInfo(book);

  el('detailTitle').innerHTML = book.titleHtml;
  el('detailSummary').innerHTML = detailDescriptionHtml(book);
  el('detailMeta').innerHTML =
    `📚 ${ndc.n}<ruby>類<rt>るい</rt></ruby> ${ndc.label} の<ruby>本棚<rt>ほんだな</rt></ruby><br>` +
    `✨ つながり：${relationDisplay[relationType] || '<ruby>入口<rt>いりぐち</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>'}`;

  el('detailModal').classList.add('open');

  logEvent('detail_event', {
    book_id: id,
    isbn: book.isbn,
    center_book_id: state.centerBookId,
    relation_type: relationType
  });

  el('detailExpand').style.display = id === state.centerBookId ? 'none' : 'block';

  el('detailExpand').onclick = () => {
    closeDetail();
    expandFrom(id, relationType);
  };

  el('detailFinal').onclick = () => {
    closeDetail();
    askFinal(id);
  };
}

function closeDetail() {
  el('detailModal').classList.remove('open');
}


// ------------------------------------------------------------
// 13. 最終選択
// ------------------------------------------------------------

function askFinal(id) {
  const book = books[id];

  el('confirmBook').innerHTML =
    `「<strong>${book.titleHtml}</strong>」を、さいごの1<ruby>冊<rt>さつ</rt></ruby>にえらびます。`;

  el('confirmModal').classList.add('open');
  el('confirmYes').onclick = () => confirmFinal(id);
}

function confirmFinal(id) {
  const book = books[id];

  state.finalBookId = id;
  el('confirmModal').classList.remove('open');

  setStep(4);
  setFocus(null);
  spawnSparkles(45);

  logEvent('final_choice', {
    final_selected_book_id: id,
    final_selected_isbn: book.isbn,
    initial_book_id: state.initial_book_id,
    same_as_initial: id === state.initial_book_id,
    graph_steps: Math.max(0, state.path.length - 1)
  });

  setGuide(
    `やったね！ 「${book.titleHtml}」を<ruby>自分<rt>じぶん</rt></ruby>で<ruby>見<rt>み</rt></ruby>つけたよ！`,
    'さいごに、<ruby>短<rt>みじか</rt></ruby>い<ruby>質問<rt>しつもん</rt></ruby>に<ruby>答<rt>こた</rt></ruby>えてね'
  );

  setTimeout(startSurvey, 900);
}


// ------------------------------------------------------------
// 14. 事後質問
// ------------------------------------------------------------

const surveyFlow = [
  {
    key: 'new_interest',
    q: '<ruby>途中<rt>とちゅう</rt></ruby>で<ruby>見<rt>み</rt></ruby>た<ruby>本<rt>ほん</rt></ruby>を<ruby>下<rt>した</rt></ruby>に<ruby>出<rt>だ</rt></ruby>したよ。<ruby>新<rt>あたら</rt></ruby>しく<ruby>気<rt>き</rt></ruby>になった<ruby>本<rt>ほん</rt></ruby>やことばはあった？',
    options: ['あった！', 'なかった']
  },
  {
    key: 'final_reason',
    q: 'さいごの<ruby>本<rt>ほん</rt></ruby>を「これにしよう」と<ruby>思<rt>おも</rt></ruby>った<ruby>決<rt>き</rt></ruby>め<ruby>手<rt>て</rt></ruby>はどれ？',
    options: [
      '<ruby>題名<rt>だいめい</rt></ruby>',
      '<ruby>表紙<rt>ひょうし</rt></ruby>',
      '<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりのことば',
      '<ruby>本<rt>ほん</rt></ruby>どうしのつながり',
      '<ruby>詳<rt>くわ</rt></ruby>しい<ruby>情報<rt>じょうほう</rt></ruby>',
      'なんとなく'
    ]
  }
];

function startSurvey() {
  surveyIndex = 0;
  state.surveyAnswers = {};
  showSurvey();
}

function surveyJourneyHtml() {
  const ids = [...new Set([...state.path, ...state.previewHistory])]
    .filter(id => books[id])
    .slice(0, 6);

  if (!ids.length) return '';

  return `
    <div class="survey-memory">
      <div class="survey-memory-title">
        <ruby>途中<rt>とちゅう</rt></ruby>で<ruby>見<rt>み</rt></ruby>た<ruby>本<rt>ほん</rt></ruby>
      </div>
      <div class="survey-memory-list">
        ${ids.map(id => `<span class="survey-memory-chip">${books[id].titleHtml}</span>`).join('')}
      </div>
    </div>
  `;
}

function showSurvey() {
  el('surveyOther').innerHTML = '';

  const item = surveyFlow[surveyIndex];

  if (!item) {
    el('surveyModal').classList.remove('open');
    showStudyCompletion();
    downloadLog();
    return;
  }

  el('surveyContext').innerHTML =
    item.key === 'new_interest' ? surveyJourneyHtml() : '';

  el('surveyQuestion').innerHTML = item.q;
  el('surveyOptions').innerHTML = '';

  item.options.forEach(option => {
    const button = document.createElement('button');
    button.className = 'survey-option';
    button.innerHTML = option;
    button.onclick = () => answerSurvey(item.key, plainTextFromHtml(option));
    el('surveyOptions').appendChild(button);
  });

  el('surveyModal').classList.add('open');
}

function answerSurvey(key, value) {
  state.surveyAnswers[key] = value;

  logEvent('post_reflection_answer', {
    question_key: key,
    answer: value
  });

  if (key === 'new_interest' && value === 'あった！') {
    showInterestDetailSurvey();
    return;
  }

  surveyIndex++;
  showSurvey();
}

function showInterestDetailSurvey() {
  el('surveyContext').innerHTML = surveyJourneyHtml();
  el('surveyQuestion').innerHTML =
    'どの<ruby>本<rt>ほん</rt></ruby>やことばが<ruby>新<rt>あたら</rt></ruby>しく<ruby>気<rt>き</rt></ruby>になった？ <ruby>近<rt>ちか</rt></ruby>いものをえらんでね。';
  el('surveyOptions').innerHTML = '';
  el('surveyOther').innerHTML = '';

  const ids = [...new Set([...state.previewHistory, ...state.path.slice(1)])]
    .filter(id => books[id])
    .slice(0, 4);

  ids.forEach(id => {
    const button = document.createElement('button');
    button.className = 'survey-option';
    button.innerHTML = books[id].titleHtml;
    button.onclick = () => saveInterestDetail(books[id].title);
    el('surveyOptions').appendChild(button);
  });

  const other = document.createElement('button');
  other.className = 'survey-option';
  other.innerHTML = 'べつのことを<ruby>書<rt>か</rt></ruby>く';
  other.onclick = showInterestTextInput;
  el('surveyOptions').appendChild(other);
}

function showInterestTextInput() {
  el('surveyOptions').style.display = 'none';
  el('surveyOther').innerHTML = `
    <input id="interestText" maxlength="80" placeholder="気になったことを、ひとこと書いてね">
    <button type="button" id="interestSave"><ruby>答<rt>こた</rt></ruby>える</button>
  `;

  el('interestSave').onclick = () => {
    const value = el('interestText').value.trim();
    if (!value) {
      el('interestText').focus();
      return;
    }
    saveInterestDetail(value);
  };

  el('interestText').focus();
}

function saveInterestDetail(value) {
  state.surveyAnswers.new_interest_detail = value;

  logEvent('post_reflection_answer', {
    question_key: 'new_interest_detail',
    answer: value
  });

  el('surveyOptions').style.display = 'grid';
  showInterestReasonSurvey();
}

function showInterestReasonSurvey() {
  el('surveyContext').innerHTML = surveyJourneyHtml();
  el('surveyQuestion').innerHTML =
    'その<ruby>本<rt>ほん</rt></ruby>やことばの、どこが<ruby>気<rt>き</rt></ruby>になった？';
  el('surveyOptions').innerHTML = '';
  el('surveyOther').innerHTML = '';

  const options = [
    ['<ruby>題名<rt>だいめい</rt></ruby>のことば', '題名のことば'],
    ['<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりのことば', '本の手がかりのことば'],
    ['<ruby>案内人<rt>あんないにん</rt></ruby>の<ruby>説明<rt>せつめい</rt></ruby>', '案内人の説明'],
    ['<ruby>本<rt>ほん</rt></ruby>どうしのつながり', '本どうしのつながり'],
    ['もっと<ruby>知<rt>し</rt></ruby>りたいと<ruby>思<rt>おも</rt></ruby>った', 'もっと知りたいと思った']
  ];

  options.forEach(([label, value]) => {
    const button = document.createElement('button');
    button.className = 'survey-option';
    button.innerHTML = label;
    button.onclick = () => saveInterestReason(value);
    el('surveyOptions').appendChild(button);
  });
}

function saveInterestReason(value) {
  state.surveyAnswers.new_interest_reason = value;

  logEvent('post_reflection_answer', {
    question_key: 'new_interest_reason',
    answer: value
  });

  surveyIndex++;
  showSurvey();
}


// ------------------------------------------------------------
// 15. 本どうしを結ぶ線
// ------------------------------------------------------------

function drawConnections(visibleIds) {
  const svg = el('connectionSvg');

  if (window.innerWidth <= 620) {
    svg.innerHTML = '';
    return;
  }

  const center = el('centerNode');
  if (!center) {
    svg.innerHTML = '';
    return;
  }

  const worldRect = svg.getBoundingClientRect();
  const centerRect = center.getBoundingClientRect();
  const centerX = centerRect.left + centerRect.width / 2 - worldRect.left;
  const centerY = centerRect.top + centerRect.height / 2 - worldRect.top;

  svg.innerHTML = '';

  visibleIds.forEach(id => {
    const node = document.querySelector(`.candidate-node[data-book-id="${id}"]`);
    if (!node) return;

    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - worldRect.left;
    const y = rect.top + rect.height / 2 - worldRect.top;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', centerX);
    line.setAttribute('y1', centerY);
    line.setAttribute('x2', x);
    line.setAttribute('y2', y);
    line.setAttribute('class', 'connection-line show');
    svg.appendChild(line);
  });
}

window.addEventListener('resize', () => {
  const ids = [...document.querySelectorAll('.candidate-node.show')]
    .map(node => node.dataset.bookId);
  drawConnections(ids);
});


// ------------------------------------------------------------
// 16. 終了画面
// ------------------------------------------------------------

// 操作ログから、実際に児童が見たり選んだりした本を取り出す。
// displayed_nodes は「画面に出ただけ」の本なので、ここでは数えない。
function getExploredBookIdsFromLogs() {
  const ids = [];

  function addBookId(id) {
    if (id && books[id] && !ids.includes(id)) {
      ids.push(id);
    }
  }

  state.logs.forEach(record => {
    if (record.event_type === 'initial_recommendation') {
      addBookId(record.initial_book_id);
    }

    if (record.event_type === 'preview_event' || record.event_type === 'detail_event') {
      addBookId(record.book_id);
    }

    if (record.event_type === 'expand_from_book' || record.event_type === 'return_to_initial_book') {
      addBookId(record.to_book_id);
    }

    if (record.event_type === 'final_choice') {
      addBookId(record.final_selected_book_id);
    }
  });

  addBookId(state.finalBookId);
  return ids;
}

// 見た本をNDCの上位分類ごとに数える。
function makeExplorationSummary() {
  const exploredIds = getExploredBookIdsFromLogs();
  const counts = new Map();

  exploredIds.forEach(id => {
    const book = books[id];
    const top = ndcTopNumber(book);
    counts.set(top, (counts.get(top) || 0) + 1);
  });

  const fields = [...counts.entries()]
    .map(([ndcNumber, count]) => ({
      ndc: ndcData.find(item => item.n === ndcNumber) || ndcData[0],
      count
    }))
    .sort((a, b) => b.count - a.count || a.ndc.n - b.ndc.n);

  return {
    exploredIds,
    fields,
    fieldCount: fields.length
  };
}

// 分野別の本の数を、児童が見やすい横棒で表示する。
function explorationBarsHtml(fields) {
  if (!fields.length) {
    return '<p class="reflection-empty">まだ<ruby>記録<rt>きろく</rt></ruby>がありません。</p>';
  }

  const maxCount = Math.max(...fields.map(item => item.count), 1);

  return fields.slice(0, 5).map(item => {
    const width = Math.max(18, Math.round((item.count / maxCount) * 100));

    return `
      <div class="reflection-row">
        <div class="reflection-label">
          <span class="reflection-icon">${item.ndc.icon}</span>
          <span>${item.ndc.n}<ruby>類<rt>るい</rt></ruby> ${item.ndc.label}</span>
          <strong>${item.count}<ruby>冊<rt>さつ</rt></ruby></strong>
        </div>
        <div class="reflection-track" aria-hidden="true">
          <span class="reflection-fill" style="width:${width}%"></span>
        </div>
      </div>
    `;
  }).join('');
}

// 探索の経路を、長くなりすぎない範囲で賞状の下部に表示する。
function explorationTrailHtml() {
  const path = state.path.filter(id => books[id]);
  if (!path.length) return '';

  const visible = path.slice(0, 4);
  const items = visible.map((id, index) => {
    const book = books[id];
    const arrow = index === 0 ? '' : '<span class="certificate-arrow">➡</span>';
    return `${arrow}<span class="certificate-trail-book">${book.titleHtml}</span>`;
  }).join('');

  const more = path.length > visible.length
    ? `<span class="certificate-more">ほか ${path.length - visible.length}<ruby>冊<rt>さつ</rt></ruby></span>`
    : '';

  return `
    <div class="certificate-trail">
      <span class="certificate-trail-title">🧵 <ruby>本<rt>ほん</rt></ruby>をたどった<ruby>道<rt>みち</rt></ruby></span>
      <div class="certificate-trail-list">${items}${more}</div>
    </div>
  `;
}

function reflectionMessageHtml(summary) {
  if (!summary.fields.length) {
    return '<ruby>本<rt>ほん</rt></ruby>を1<ruby>冊<rt>さつ</rt></ruby>えらぶところまで、よくたどったね！';
  }

  const first = summary.fields[0].ndc;

  if (summary.fieldCount === 1) {
    return `こんかいは <strong>${first.n}<ruby>類<rt>るい</rt></ruby> ${first.label}</strong> の<ruby>本<rt>ほん</rt></ruby>を
      ${summary.exploredIds.length}<ruby>冊<rt>さつ</rt></ruby><ruby>見<rt>み</rt></ruby>ながらたどったね！`;
  }

  return `こんかいは <strong>${summary.fieldCount}つの<ruby>分野<rt>ぶんや</rt></ruby></strong>の<ruby>本<rt>ほん</rt></ruby>を
    ${summary.exploredIds.length}<ruby>冊<rt>さつ</rt></ruby><ruby>見<rt>み</rt></ruby>ながらたどったね！`;
}

function showStudyCompletion() {
  const book = books[state.finalBookId];
  const ndc = ndcInfo(book);
  const graph = el('graph');
  const summary = makeExplorationSummary();
  const subjects = book.subjects.slice(0, 3);

  graph.innerHTML = `
    <div class="finish-node">
      <section class="finish-card">
        <header class="certificate-header">
          <div class="certificate-star" aria-hidden="true">★</div>
          <div>
            <div class="certificate-kicker"><ruby>本<rt>ほん</rt></ruby>のたんけんしょう</div>
            <h2>きみの<ruby>本<rt>ほん</rt></ruby>さがしの<ruby>記録<rt>きろく</rt></ruby></h2>
          </div>
          <div class="certificate-star" aria-hidden="true">★</div>
        </header>

        <div class="certificate-grid">
          <section class="certificate-book-panel">
            <h3>📘 さいごにえらんだ<ruby>本<rt>ほん</rt></ruby></h3>

            <div class="certificate-book-main">
              ${coverHtml(book)}
              <div class="certificate-book-info">
                <div class="certificate-book-title">${book.titleHtml}</div>
                ${book.isbn ? `<div class="certificate-isbn">ISBN ${escapeHtml(book.isbn)}</div>` : ''}
                ${subjects.length ? `
                  <div class="certificate-subject-title">この<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかり</div>
                  <div class="certificate-subjects">
                    ${subjects.map(subject => `<span>${escapeHtml(subject)}</span>`).join('')}
                  </div>
                ` : ''}
              </div>
            </div>

            <div class="finish-shelf">
              <span>📚 <strong>${ndc.n}<ruby>類<rt>るい</rt></ruby> ${ndc.label}</strong> の<ruby>本棚<rt>ほんだな</rt></ruby></span>
              <small>NDC ${escapeHtml(String(book.ndc || ndc.n))}</small>
            </div>

            <div class="finish-go-shelf">
              ➡ この<ruby>画面<rt>がめん</rt></ruby>をもって、<ruby>図書館<rt>としょかん</rt></ruby>の
              <strong>${ndc.n}<ruby>類<rt>るい</rt></ruby> ${ndc.label}</strong> のコーナーへ<ruby>行<rt>い</rt></ruby>ってみよう！
            </div>
          </section>

          <section class="certificate-reflection-panel">
            <h3>✨ たんけんのふりかえり</h3>

            <div class="reflection-stats">
              <div><strong>${summary.exploredIds.length}</strong><span><ruby>見<rt>み</rt></ruby>た<ruby>本<rt>ほん</rt></ruby></span></div>
              <div><strong>${summary.fieldCount}</strong><span>たどった<ruby>分野<rt>ぶんや</rt></ruby></span></div>
            </div>

            <div class="reflection-chart" aria-label="探索した本の分野別冊数">
              ${explorationBarsHtml(summary.fields)}
            </div>

            <div class="reflection-message">
              ${reflectionMessageHtml(summary)}
            </div>
          </section>
        </div>

        ${explorationTrailHtml()}

        <div class="certificate-footer">
          <span class="finish-camera">📷 この<ruby>画面<rt>がめん</rt></ruby>をスクショしてね</span>
          <span class="certificate-finish-message">これで<ruby>今回<rt>こんかい</rt></ruby>の<ruby>案内<rt>あんない</rt></ruby>はおしまい！</span>
        </div>
      </section>
    </div>
  `;

  const finishNode = graph.querySelector('.finish-node');
  if (finishNode) {
    trySetCover(finishNode, book);
  }

  // 終了画面では右側の操作案内を隠し、賞状を主役にする。
  el('journeyPanel').hidden = true;
  setStep(4);
  setFocus(null);

  document.body.classList.add('study-complete');
  el('searchButton').disabled = true;
  el('queryInput').readOnly = true;

  setGuide(
  `<strong>きみの<ruby>本<rt>ほん</rt></ruby>さがしの<ruby>記録<rt>きろく</rt></ruby>ができたよ！</strong><br>` +
  `この<ruby>画面<rt>がめん</rt></ruby>をスクショして、` +
  `<strong>${ndc.n}<ruby>類<rt>るい</rt></ruby> ${ndc.label}</strong> の` +
  `<ruby>本棚<rt>ほんだな</rt></ruby>へ<ruby>行<rt>い</rt></ruby>ってみよう！`,
  ''
  );

  spawnSparkles(50);

  logEvent('study_complete', {
    final_selected_book_id: book.id,
    final_selected_isbn: book.isbn,
    shelf_ndc_top: ndc.n,
    shelf_label: plainTextFromHtml(ndc.label)
  });
}


// ------------------------------------------------------------
// 17. 演出
// ------------------------------------------------------------

function spawnSparkles(count) {
  const layer = el('particleLayer');

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('span');
    particle.className = 'particle';
    particle.style.left = (35 + Math.random() * 30) + '%';
    particle.style.top = (35 + Math.random() * 36) + '%';
    particle.style.animationDelay = (Math.random() * 0.5) + 's';

    layer.appendChild(particle);
    setTimeout(() => particle.remove(), 1900);
  }
}


// ------------------------------------------------------------
// 18. ボタン設定と初期化
// ------------------------------------------------------------

el('startExperimentButton').onclick = startExperiment;

el('participantInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') startExperiment();
});

el('searchButton').onclick = startSearch;

el('queryInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') startSearch();
});

el('speechNext').onclick = continueDialogue;
el('returnToStartButton').onclick = returnToInitialBook;
el('detailClose').onclick = closeDetail;
el('confirmCancel').onclick = () => el('confirmModal').classList.remove('open');

// ページを開いた時にJSONを読み込む。
el('startExperimentButton').disabled = true;
setDatasetStatus('図書データを読み込んでいます……');
loadBookDataset();
