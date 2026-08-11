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

  if (value.length < 2) {
    return value ? [value] : [];
  }

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

  if (!a.length || !b.length) {
    return 0;
  }

  const counts = new Map();

  a.forEach(item => {
    counts.set(item, (counts.get(item) || 0) + 1);
  });

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
  const isbn = String(record.isbn || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();

  if (isbn) {
    return `ISBN_${isbn}`;
  }

  return `BOOK_${String(index + 1).padStart(3, '0')}`;
}

// JSONの1件を、画面で扱いやすい形へそろえる。
function prepareBook(record, index) {
  const subjects = Array.isArray(record.subjects)
    ? record.subjects
        .filter(Boolean)
        .map(String)
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
    triples: Array.isArray(record.rdf_triples)
      ? record.rdf_triples
      : [],
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
  const setA = new Set(
    bookA.subjects.map(subjectKey)
  );

  return bookB.subjects.filter(subject => {
    return setA.has(subjectKey(subject));
  });
}

function bookText(book) {
  return [
    book.title,
    ...book.subjects
  ].join(' ');
}

// 2冊の関係を、現在のJSONで確認できる情報から決める。
// RDF三つ組が追加された場合は concept_path も利用できる。
function relationBetween(bookA, bookB) {
  const shared = commonSubjects(bookA, bookB);

  if (shared.length > 0) {
    return 'shared_subject';
  }

  if (
    ndcTopNumber(bookA) ===
    ndcTopNumber(bookB)
  ) {
    return 'shared_ndc';
  }

  return 'local_text_match';
}

// 関連本の並び順を決めるためのローカル用スコア。
// 本実験のSBERT類似度とは別物で、静的画面の確認にだけ使う。
function relatedScore(bookA, bookB) {
  const sharedCount =
    commonSubjects(bookA, bookB).length;

  const sameTopNdc =
    ndcTopNumber(bookA) ===
    ndcTopNumber(bookB)
      ? 1
      : 0;

  const sameNdc =
    String(bookA.ndc) ===
    String(bookB.ndc)
      ? 1
      : 0;

  const textScore =
    diceScore(
      bookText(bookA),
      bookText(bookB)
    );

  return (
    sharedCount * 10 +
    sameNdc * 4 +
    sameTopNdc * 2 +
    textScore * 5
  );
}

// 全冊について「次に出す候補」をあらかじめ作る。
function buildRelatedBooks() {
  bookList.forEach(centerBook => {

    const ranked = bookList
      .filter(book => {
        return book.id !== centerBook.id;
      })
      .map(book => ({
        id: book.id,
        score: relatedScore(
          centerBook,
          book
        ),
        relation: relationBetween(
          centerBook,
          book
        )
      }))
      .sort((a, b) => {
        return b.score - a.score;
      });

    centerBook.related =
      ranked
        .slice(0, 8)
        .map(item => item.id);

    centerBook.relationMap = {};

    ranked
      .slice(0, 8)
      .forEach(item => {
        centerBook.relationMap[item.id] =
          item.relation;
      });
  });
}

function setDatasetStatus(
  message,
  isError = false
) {
  const status = el('datasetStatus');

  if (!status) {
    return;
  }

  status.textContent = message;

  status.classList.toggle(
    'error',
    isError
  );
}

async function loadBookDataset() {
  try {
    const response =
      await fetch(
        DATASET_URL,
        {
          cache: 'no-store'
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const records =
      await response.json();

    if (
      !Array.isArray(records) ||
      records.length === 0
    ) {
      throw new Error(
        '図書データが空です'
      );
    }

    bookList =
      records.map(prepareBook);

    books =
      Object.fromEntries(
        bookList.map(book => [
          book.id,
          book
        ])
      );

    semanticMeta =
      Object.fromEntries(
        bookList.map(book => [
          book.id,
          {
            subjects:
              book.subjects.map(
                escapeHtml
              ),

            triples:
              book.triples.map(
                triple =>
                  triple.map(
                    item =>
                      escapeHtml(
                        String(item)
                      )
                  )
              )
          }
        ])
      );

    buildRelatedBooks();

    datasetReady = true;

    el('startExperimentButton')
      .disabled = false;

    setDatasetStatus(
      `図書データ ${bookList.length}冊を読み込みました。`
    );

  } catch (error) {

    console.error(
      'dataset load error',
      error
    );

    datasetReady = false;

    el('startExperimentButton')
      .disabled = true;

    setDatasetStatus(
      '図書データを読み込めませんでした。GitHub Pages、Live Server、またはローカルHTTPサーバーで開いてください。',
      true
    );
  }
}


// ------------------------------------------------------------
// 2. ローカル検索
// ------------------------------------------------------------

function scoreBookForQuery(
  book,
  query
) {
  const q =
    normalizeText(query);

  const title =
    normalizeText(book.title);

  const subjectValues =
    book.subjects
      .map(normalizeText)
      .filter(Boolean);

  if (!q) {
    return 0;
  }

  let score =
    diceScore(
      query,
      book.title
    ) * 0.72;

  if (
    title.includes(q) ||
    q.includes(title)
  ) {
    score =
      Math.max(
        score,
        0.98
      );
  }

  subjectValues.forEach(subject => {

    if (!subject) {
      return;
    }

    if (
      q.includes(subject) ||
      subject.includes(q)
    ) {
      score =
        Math.max(
          score,
          0.94
        );
    } else {
      score =
        Math.max(
          score,
          diceScore(
            query,
            subject
          ) * 0.82
        );
    }
  });

  return Math.min(
    1,
    score
  );
}

function findEntryBook(query) {
  const ranked =
    bookList
      .map(book => ({
        book,
        score:
          scoreBookForQuery(
            book,
            query
          )
      }))
      .sort((a, b) => {
        return b.score - a.score;
      });

  const best = ranked[0];

  // 28冊の中に手がかりがほぼ無い時は、
  // 関係のない本を無理に出さない。
  if (
    !best ||
    best.score < 0.18
  ) {
    return null;
  }

  best.book.similarity =
    best.score;

  return best.book;
}

function relationFor(
  centerId,
  targetId
) {
  return (
    books[centerId]
      ?.relationMap
      ?.[targetId] ||
    'local_text_match'
  );
}


// ------------------------------------------------------------
// 3. 実験開始と状態管理
// ------------------------------------------------------------

function resetSession(
  participantId
) {
  state.participant_id =
    participantId;

  state.session_id =
    'S_' + Date.now();

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
  if (!datasetReady) {
    return;
  }

  const participantId =
    el('participantInput')
      .value
      .trim();

  if (!participantId) {
    el('participantInput')
      .focus();

    return;
  }

  resetSession(
    participantId
  );

  el('experimentStartModal')
    .classList
    .remove('open');

  logEvent(
    'experiment_start'
  );

  el('queryInput')
    .focus();
}


// ------------------------------------------------------------
// 4. 共通の画面操作
// ------------------------------------------------------------

function setStep(step) {
  document
    .querySelectorAll('.step-item')
    .forEach(item => {

      const number =
        Number(
          item.dataset.step
        );

      item.classList.toggle(
        'active',
        number === step
      );

      item.classList.toggle(
        'done',
        number < step
      );
    });
}

function setGuide(
  messageHtml,
  hintHtml = ''
) {
  el('speechText')
    .innerHTML =
    messageHtml;

  el('guideMessage')
    .innerHTML =
    hintHtml ||
    '<ruby>下<rt>した</rt></ruby>のフクロウの<ruby>案内<rt>あんない</rt></ruby>を<ruby>見<rt>み</rt></ruby>てね。';

  el('nextHint')
    .style.display =
    'none';

  el('speechNext')
    .classList
    .remove('show');

  el('speech')
    .classList
    .remove('tap-ready');
}

function guideStep(
  messageHtml,
  hintHtml = ''
) {
  setGuide(
    messageHtml,
    hintHtml
  );

  return new Promise(resolve => {

    dialogueResolver =
      resolve;

    el('speechNext')
      .classList
      .add('show');

    el('speech')
      .classList
      .add('tap-ready');
  });
}

function continueDialogue() {
  if (!dialogueResolver) {
    return;
  }

  const resolve =
    dialogueResolver;

  dialogueResolver = null;

  el('speechNext')
    .classList
    .remove('show');

  el('speech')
    .classList
    .remove('tap-ready');

  resolve();
}

function setFocus(mode) {
  document.body.classList.remove(
    'focus-search',
    'focus-center',
    'focus-candidates',
    'focus-preview'
  );

  if (mode) {
    document.body.classList.add(
      'focus-' + mode
    );
  }
}

function wait(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function plainTextFromHtml(
  html = ''
) {
  const div =
    document.createElement('div');

  div.innerHTML = html;

  return div.textContent || '';
}

function escapeHtml(text) {
  return String(text)
    .replace(
      /[&<>'"]/g,
      char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[char])
    );
}


// ------------------------------------------------------------
// 5. 操作ログ
// ------------------------------------------------------------

function logEvent(
  eventType,
  extra = {}
) {
  const record = {
    participant_id:
      state.participant_id,

    session_id:
      state.session_id,

    original_input:
      state.original_input,

    event_type:
      eventType,

    timestamp:
      new Date()
        .toISOString(),

    ...extra
  };

  state.logs.push(
    record
  );

  console.log(
    '[research-log]',
    record
  );
}

function downloadLog() {
  const json =
    JSON.stringify(
      state.logs,
      null,
      2
    );

  const blob =
    new Blob(
      [json],
      {
        type:
          'application/json'
      }
    );

  const url =
    URL.createObjectURL(
      blob
    );

  const link =
    document.createElement('a');

  link.href = url;

  link.download =
    `knowledge_alchemy_${state.participant_id}_${state.session_id}.json`;

  link.click();

  URL.revokeObjectURL(
    url
  );
}


// ------------------------------------------------------------
// 6. NDC・歩いた道・書影
// ------------------------------------------------------------

function ndcTopNumber(book) {
  const raw =
    String(
      book.ndc ?? ''
    );

  const number =
    parseInt(
      raw.charAt(0),
      10
    );

  return Number.isFinite(number)
    ? number
    : 0;
}

function ndcInfo(book) {
  const number =
    ndcTopNumber(book);

  return (
    ndcData.find(
      item =>
        item.n === number
    ) ||
    ndcData[0]
  );
}

function renderJourney() {
  const panel =
    el('journeyPanel');

  const trail =
    el('journeyTrail');

  const returnButton =
    el('returnToStartButton');

  if (
    state.path.length < 2
  ) {
    panel.hidden = true;

    trail.innerHTML = '';

    returnButton.hidden = true;

    return;
  }

  panel.hidden = false;

  trail.innerHTML = '';

  state.path.forEach(
    (id, index) => {

      if (index > 0) {
        const arrow =
          document.createElement(
            'span'
          );

        arrow.className =
          'journey-arrow';

        arrow.textContent =
          '➡';

        trail.appendChild(
          arrow
        );
      }

      const book =
        books[id];

      if (!book) {
        return;
      }

      const step =
        document.createElement(
          'span'
        );

      step.className =
        'journey-step' +
        (
          index ===
          state.path.length - 1
            ? ' current'
            : ''
        );

      step.textContent =
        book.title;

      trail.appendChild(
        step
      );
    }
  );

  returnButton.hidden =
    state.centerBookId ===
    state.initial_book_id;
}

function coverHtml(book) {

    const image =
    book.cover_url
      ? `<img src="${escapeHtml(book.cover_url)}" alt="${escapeHtml(book.title)}の書影">`
      : '';

  return `
    <div class="cover">
      <span class="cover-fallback" aria-hidden="true"></span>
      ${image}
    </div>
  `;
}

function trySetCover(
  container,
  book
) {
  if (!book.cover_url) {
    return;
  }

  const cover =
    container.querySelector(
      '.cover'
    );

  const image =
    cover?.querySelector(
      'img'
    );

  if (!cover || !image) {
    return;
  }

  image.onload = () => {
    cover.classList.add(
      'has-image'
    );
  };

  image.onerror = () => {
    cover.classList.remove(
      'has-image'
    );
  };
}


// ------------------------------------------------------------
// 7. 本の手がかり・本棚情報
// ------------------------------------------------------------

function subjectChipsHtml(book) {
  const subjects =
    book.subjects.length
      ? book.subjects
      : [
          plainTextFromHtml(
            ndcInfo(book).label
          )
        ];

  return subjects
    .slice(0, 4)
    .map(subject => `
      <span class="subject-chip">
        ${escapeHtml(subject)}
      </span>
    `)
    .join('');
}

function shelfInfoHtml(
  book,
  compact = false
) {
  const ndc =
    ndcInfo(book);

  if (compact) {
    return `
      <span class="candidate-shelf">
        📚
        ${ndc.n}<ruby>類<rt>るい</rt></ruby>
        ${ndc.label}
      </span>
    `;
  }

  return `
    <div class="shelf-info">
      <span class="shelf-icon">📚</span>

      <span>
        この<ruby>本<rt>ほん</rt></ruby>は
        <strong>
          ${ndc.n}<ruby>類<rt>るい</rt></ruby>
          ${ndc.label}
        </strong>
        の<ruby>本棚<rt>ほんだな</rt></ruby>
      </span>
    </div>
  `;
}


// ------------------------------------------------------------
// 8. 固定テンプレートによる案内文
// ------------------------------------------------------------

// 本実験では自由生成LLMを使わない。
// relation_type に応じた固定文へ、図書データを差し込む。
function makeGuideExplanation(book) {
  const subjects =
    book.subjects.slice(0, 3);

  const subjectText =
    subjects.length
      ? subjects
          .map(subject => `「${escapeHtml(subject)}」`)
          .join('、')
      : '';

  const ndc =
    ndcInfo(book);

  if (
    book.triples &&
    book.triples.length
  ) {
    const triple =
      book.triples[0];

    if (
      Array.isArray(triple) &&
      triple.length >= 3
    ) {
      return `
        この<ruby>本<rt>ほん</rt></ruby>は、
        ${subjectText || `「${ndc.child}」`}
        が<ruby>手<rt>て</rt></ruby>がかりだよ。<br>

        ことばのつながりでは、
        「${escapeHtml(triple[0])}」
        ➡
        「${escapeHtml(triple[1])}」
        ➡
        「${escapeHtml(triple[2])}」
        とたどれるよ。<br>

        「${escapeHtml(state.original_input)}」から、
        ほかの<ruby>本<rt>ほん</rt></ruby>にも
        つながっていけそうだね！
      `;
    }
  }

  return `
    この<ruby>本<rt>ほん</rt></ruby>には、
    ${subjectText || `「${ndc.child}」`}
    という<ruby>手<rt>て</rt></ruby>がかりがあるよ。<br>

    「${escapeHtml(state.original_input)}」が
    <ruby>気<rt>き</rt></ruby>になったなら、
    このことばを<ruby>手<rt>て</rt></ruby>がかりに
    ほかの<ruby>本<rt>ほん</rt></ruby>も
    <ruby>見<rt>み</rt></ruby>てみよう！
  `;
}


// ------------------------------------------------------------
// 9. 中央本カード
// ------------------------------------------------------------

function centerCardHtml(
  book,
  isEntry
) {
  const fitHtml =
    isEntry &&
    typeof book.similarity ===
      'number'
      ? `
        <div
          id="centerFitStage"
          class="center-stage fit-stage"
          style="--fit-score:${Math.round(book.similarity * 100)}%"
        >

          <div class="fit-card">

            <div class="fit-burst">

              <span class="fit-label">
                ことばとの<br>
                ぴったり
                <ruby>度<rt>ど</rt></ruby>
              </span>

              <span class="fit-number">
                ${Math.round(book.similarity * 100)}
              </span>

              <span class="fit-unit">
                %
              </span>

            </div>

            <div>

              <div class="fit-track">
                <div class="fit-fill"></div>
              </div>

              <div class="fit-note">
                ことばとの
                <ruby>近<rt>ちか</rt></ruby>さの
                <ruby>目安<rt>めやす</rt></ruby>
              </div>

            </div>

          </div>

        </div>
      `
      : '';

  return `
    <article class="book-card center">

      <div class="book-body">

        ${coverHtml(book)}

        <div>

          <p class="book-title">
            ${book.titleHtml}
          </p>

          <span class="book-tag">
            ${
              isEntry
                ? '✦ <ruby>入口<rt>いりぐち</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>'
                : '● いまの<ruby>中心<rt>ちゅうしん</rt></ruby>'
            }
          </span>

        </div>

      </div>

      ${fitHtml}

      <div
        id="centerSubjectStage"
        class="center-stage subject-stage"
      >

        <div class="subject-kicker">
          この<ruby>本<rt>ほん</rt></ruby>の
          <ruby>手<rt>て</rt></ruby>がかり
        </div>

        <div class="subject-list">
          ${subjectChipsHtml(book)}
        </div>

        ${shelfInfoHtml(book)}

      </div>

      <div
        id="centerActions"
        class="center-actions"
      >

        <button
          class="btn info"
          type="button"
          data-action="detail"
        >
          <ruby>詳<rt>くわ</rt></ruby>しく
          <ruby>見<rt>み</rt></ruby>る
        </button>

        <button
          class="btn gold"
          type="button"
          data-action="final"
        >
          これをかりたい！
        </button>

        <button
          class="btn main-next"
          type="button"
          data-action="related"
        >
          ✦ この<ruby>本<rt>ほん</rt></ruby>から、
          つながる<ruby>本<rt>ほん</rt></ruby>を
          <ruby>見<rt>み</rt></ruby>る！
        </button>

      </div>

    </article>
  `;
}

function showCenter(
  book,
  isEntry = false,
  quick = false
) {
  const graph =
    el('graph');

  graph.innerHTML = `
    <div
      id="centerNode"
      class="center-node"
    >
      ${centerCardHtml(book, isEntry)}
    </div>
  `;

  const center =
    el('centerNode');

  trySetCover(
    center,
    book
  );

  center
    .querySelector(
      '[data-action="detail"]'
    )
    .onclick = () =>
      openDetail(book.id);

  center
    .querySelector(
      '[data-action="final"]'
    )
    .onclick = () =>
      askFinal(book.id);

  center
    .querySelector(
      '[data-action="related"]'
    )
    .onclick = () =>
      revealRelated(book.id);

  renderJourney();

  drawConnections([]);

  if (quick) {
    showCenterImmediately(
      book,
      isEntry
    );

    return;
  }

  presentCenterSequence(
    book,
    isEntry
  );
}


// 一度見た本に戻る時は、説明を最初から繰り返さない。
function showCenterImmediately(
  book,
  isEntry = false
) {
  const fit =
    el('centerFitStage');

  const subject =
    el('centerSubjectStage');

  const actions =
    el('centerActions');

  if (fit) {
    fit.classList.add(
      'visible'
    );
  }

  if (subject) {
    subject.classList.add(
      'visible'
    );
  }

  if (actions) {
    actions.classList.add(
      'visible'
    );
  }

  setFocus('center');

  setGuide(
    `「${book.titleHtml}」にもどってきたよ。`,
    'この<ruby>本<rt>ほん</rt></ruby>から、もういちど<ruby>選<rt>えら</rt></ruby>べるよ'
  );
}


// ------------------------------------------------------------
// 10. 中央本を順番に説明
// ------------------------------------------------------------

async function presentCenterSequence(
  book,
  isEntry = false
) {
  const fit =
    el('centerFitStage');

  const subject =
    el('centerSubjectStage');

  const actions =
    el('centerActions');

  if (!subject || !actions) {
    return;
  }

  setFocus('center');

  await guideStep(
    `まずは<ruby>題名<rt>だいめい</rt></ruby>を<ruby>見<rt>み</rt></ruby>てみよう。<br>
    「${book.titleHtml}」`,
    '<ruby>読<rt>よ</rt></ruby>めたら「つぎへ ▼」'
  );

  if (fit) {
    fit.classList.add(
      'visible'
    );

    spawnSparkles(14);

    const fitValue =
      Math.round(
        book.similarity * 100
      );

    logEvent(
      'fit_score_displayed',
      {
        book_id:
          book.id,

        fit_score:
          fitValue
      }
    );

    await guideStep(
      `おっ！ きみのことばと、この<ruby>本<rt>ほん</rt></ruby>の
      「ぴったり<ruby>度<rt>ど</rt></ruby>」は
      <strong>${fitValue}%</strong>！<br>

      <small>
        これは<ruby>正解<rt>せいかい</rt></ruby>の
        <ruby>点数<rt>てんすう</rt></ruby>ではなく、
        ことばの<ruby>近<rt>ちか</rt></ruby>さの
        <ruby>目安<rt>めやす</rt></ruby>だよ。
      </small>`,
      '<ruby>見<rt>み</rt></ruby>おわったら「つぎへ ▼」'
    );
  }

  subject.classList.add(
    'visible'
  );

  spawnSparkles(10);

  const ndc =
    ndcInfo(book);

  await guideStep(
    `<ruby>次<rt>つぎ</rt></ruby>は、
    この<ruby>本<rt>ほん</rt></ruby>の
    <ruby>手<rt>て</rt></ruby>がかりを
    <ruby>見<rt>み</rt></ruby>てみよう！<br>

    この<ruby>本<rt>ほん</rt></ruby>には、
    こんな「<ruby>手<rt>て</rt></ruby>がかりのことば」が
    ついているよ。<br>

    <ruby>図書館<rt>としょかん</rt></ruby>では、
    <strong>
      ${ndc.n}<ruby>類<rt>るい</rt></ruby>
      ${ndc.label}
    </strong>
    の<ruby>本棚<rt>ほんだな</rt></ruby>を
    <ruby>探<rt>さが</rt></ruby>してみよう！`,
    '<ruby>気<rt>き</rt></ruby>になることばを<ruby>見<rt>み</rt></ruby>つけたら「つぎへ ▼」'
  );

  const explanation =
    makeGuideExplanation(
      book
    );

  spawnSparkles(12);

  await guideStep(
    explanation,
    '<ruby>案内人<rt>あんないにん</rt></ruby>の<ruby>話<rt>はなし</rt></ruby>を<ruby>読<rt>よ</rt></ruby>んだら「つぎへ ▼」'
  );

  actions.classList.add(
    'visible'
  );

  setGuide(
    '<ruby>気<rt>き</rt></ruby>になった？ ここからは、きみが<ruby>次<rt>つぎ</rt></ruby>をえらべるよ！',
    '<ruby>中央<rt>ちゅうおう</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>のボタンを1つえらんでね'
  );
}


// ------------------------------------------------------------
// 11. 関連本カード
// ------------------------------------------------------------

function candidateHtml(
  book,
  relation
) {
  return `
    <article class="book-card candidate-card">

      <div class="book-body">

        ${coverHtml(book)}

        <div>

          <p class="book-title">
            ${book.titleHtml}
          </p>

          ${shelfInfoHtml(book, true)}

          <span class="relation-tag">
            ${relationDisplay[relation] || 'ことばがちかい'}
          </span>

        </div>

      </div>

      <div class="preview">

        <p>
          ${
            book.subjects.length
              ? `この<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりは「${book.subjects.slice(0, 3).map(escapeHtml).join('・')}」だよ。`
              : `${plainTextFromHtml(ndcInfo(book).label)}についての本だよ。`
          }
        </p>

        <div class="preview-actions">

          <button
            class="mini-btn detail"
            type="button"
            data-caction="detail"
          >
            <ruby>詳<rt>くわ</rt></ruby>しく
            <ruby>見<rt>み</rt></ruby>る
          </button>

          <button
            class="mini-btn final"
            type="button"
            data-caction="final"
          >
            これをかりたい！
          </button>

          <button
            class="mini-btn expand"
            type="button"
            data-caction="expand"
          >
            ✨ この<ruby>本<rt>ほん</rt></ruby>から
            もっと<ruby>探<rt>さが</rt></ruby>す
          </button>

        </div>

      </div>

    </article>
  `;
}


// ------------------------------------------------------------
// 12. 関連本を1冊ずつ表示
// ------------------------------------------------------------

async function revealRelated(
  centerId
) {
  const center =
    books[centerId];

  if (!center) {
    return;
  }

  state.previewBookId = null;

  setStep(3);

  setFocus(
    'candidates'
  );

  const ids =
    center.related.slice(
      0,
      RELATED_BOOK_COUNT
    );

  const token =
    ++state.revealToken;

  const graph =
    el('graph');

  graph
    .querySelectorAll(
      '.candidate-node'
    )
    .forEach(node => {
      node.remove();
    });

  drawConnections([]);

  const relatedButton =
    el('centerNode')
      ?.querySelector(
        '[data-action="related"]'
      );

  if (relatedButton) {
    relatedButton.disabled = true;

    relatedButton.innerHTML =
      'しゅわわわ…… <ruby>本<rt>ほん</rt></ruby>を<ruby>探<rt>さが</rt></ruby>し<ruby>中<rt>ちゅう</rt></ruby>';
  }

  setGuide(
    'しゅわわわ……。この<ruby>本<rt>ほん</rt></ruby>からのびる<ruby>道<rt>みち</rt></ruby>を、ゆっくりたどっているよ……。',
    '1<ruby>冊<rt>さつ</rt></ruby>ずつ<ruby>見<rt>み</rt></ruby>つけよう'
  );

  spawnSparkles(16);

  await wait(
    UX_TIMING.relatedWarmup
  );

  if (
    token !==
    state.revealToken
  ) {
    return;
  }

  logEvent(
    'displayed_nodes',
    {
      center_book_id:
        centerId,

      displayed_nodes:
        ids.map(id => ({
          book_id:
            id,

          relation_type:
            relationFor(
              centerId,
              id
            )
        }))
    }
  );

  const countWords = [
    '1<ruby>冊目<rt>さつめ</rt></ruby>',
    '2<ruby>冊目<rt>さつめ</rt></ruby>',
    '3<ruby>冊目<rt>さつめ</rt></ruby>',
    '4<ruby>冊目<rt>さつめ</rt></ruby>'
  ];

  for (
    let index = 0;
    index < ids.length;
    index++
  ) {
    if (
      token !==
      state.revealToken
    ) {
      return;
    }

    const id =
      ids[index];

    const book =
      books[id];

    const relation =
      relationFor(
        centerId,
        id
      );

    const node =
      document.createElement(
        'div'
      );

    node.className =
      'candidate-node';

    node.dataset.pos =
      index;

    node.dataset.bookId =
      id;

    node.innerHTML =
      candidateHtml(
        book,
        relation
      );

    graph.appendChild(
      node
    );

    trySetCover(
      node,
      book
    );

    node
      .querySelector(
        '.candidate-card'
      )
      .addEventListener(
        'click',
        event => {

          if (
            event.target
              .closest('button')
          ) {
            return;
          }

          previewBook(
            id,
            node,
            relation
          );
        }
      );

    node
      .querySelector(
        '[data-caction="detail"]'
      )
      .onclick = event => {

        event.stopPropagation();

        openDetail(id);
      };

    node
      .querySelector(
        '[data-caction="final"]'
      )
      .onclick = event => {

        event.stopPropagation();

        askFinal(id);
      };

    node
      .querySelector(
        '[data-caction="expand"]'
      )
      .onclick = event => {

        event.stopPropagation();

        expandFrom(id);
      };

    await wait(
      index === 0
        ? 650
        : UX_TIMING.relatedGap
    );

    if (
      token !==
      state.revealToken
    ) {
      return;
    }

    node.classList.add(
      'show'
    );

    drawConnections(
      ids.slice(
        0,
        index + 1
      )
    );

    spawnSparkles(9);

    setGuide(
      `${countWords[index]}が<ruby>見<rt>み</rt></ruby>つかった！<br>
      「${book.titleHtml}」`,
      '<ruby>題名<rt>だいめい</rt></ruby>をちょっと<ruby>見<rt>み</rt></ruby>ていてね'
    );
  }

  await wait(
    UX_TIMING.afterRelated
  );

  if (
    token !==
    state.revealToken
  ) {
    return;
  }

  if (relatedButton) {
    relatedButton.style.display =
      'none';
  }

  setGuide(
    `${ids.length}<ruby>冊<rt>さつ</rt></ruby>そろったよ！<br>
    <ruby>題名<rt>だいめい</rt></ruby>を<ruby>見<rt>み</rt></ruby>て、
    <ruby>気<rt>き</rt></ruby>になる<ruby>本<rt>ほん</rt></ruby>を
    1<ruby>冊<rt>さつ</rt></ruby>タップしてみよう。`,
    'いま<ruby>押<rt>お</rt></ruby>せるのは<ruby>本<rt>ほん</rt></ruby>のカードだよ'
  );
}


// ------------------------------------------------------------
// 13. 関連本プレビュー
// ------------------------------------------------------------

function previewBook(
  id,
  node,
  relation
) {
  document
    .querySelectorAll(
      '.candidate-node'
    )
    .forEach(otherNode => {

      if (
        otherNode !== node
      ) {
        otherNode.classList
          .remove(
            'preview-open'
          );
      }
    });

  const open =
    !node.classList.contains(
      'preview-open'
    );

  node.classList.toggle(
    'preview-open',
    open
  );

  state.previewBookId =
    open
      ? id
      : null;

  if (open) {

    if (
      !state.previewHistory
        .includes(id)
    ) {
      state.previewHistory
        .push(id);
    }

    setFocus(
      'preview'
    );

    logEvent(
      'preview_event',
      {
        book_id:
          id,

        center_book_id:
          state.centerBookId,

        relation_type:
          relation
      }
    );

    setGuide(
      `「${books[id].titleHtml}」が<ruby>気<rt>き</rt></ruby>になったんだね。<br>
      まずは<ruby>短<rt>みじか</rt></ruby>い
      <ruby>説明<rt>せつめい</rt></ruby>を
      <ruby>読<rt>よ</rt></ruby>んでみよう。`,
      'そのあと、つぎの<ruby>行動<rt>こうどう</rt></ruby>をえらべるよ'
    );

  } else {

    setFocus(
      'candidates'
    );

    setGuide(
      '<ruby>気<rt>き</rt></ruby>になる<ruby>本<rt>ほん</rt></ruby>を、もう1<ruby>冊<rt>さつ</rt></ruby><ruby>見<rt>み</rt></ruby>てもいいよ。',
      'じぶんのペースでえらんでね'
    );
  }
}


// ------------------------------------------------------------
// 14. 接続線
// ------------------------------------------------------------

function drawConnections(
  visibleIds
) {
  const svg =
    el('connectionSvg');

  if (
    window.innerWidth <= 620
  ) {
    svg.innerHTML = '';

    return;
  }

  const center =
    el('centerNode');

  if (!center) {
    svg.innerHTML = '';

    return;
  }

  const svgRect =
    svg.getBoundingClientRect();

  const centerRect =
    center.getBoundingClientRect();

  const centerX =
    centerRect.left +
    centerRect.width / 2 -
    svgRect.left;

  const centerY =
    centerRect.top +
    centerRect.height / 2 -
    svgRect.top;

  svg.innerHTML = '';

  visibleIds.forEach(id => {

    const node =
      document.querySelector(
        `.candidate-node[data-book-id="${id}"]`
      );

    if (!node) {
      return;
    }

    const rect =
      node.getBoundingClientRect();

    const targetX =
      rect.left +
      rect.width / 2 -
      svgRect.left;

    const targetY =
      rect.top +
      rect.height / 2 -
      svgRect.top;

    const line =
      document.createElementNS(
        'http://www.w3.org/2000/svg',
        'line'
      );

    line.setAttribute(
      'x1',
      centerX
    );

    line.setAttribute(
      'y1',
      centerY
    );

    line.setAttribute(
      'x2',
      targetX
    );

    line.setAttribute(
      'y2',
      targetY
    );

    line.setAttribute(
      'class',
      'connection-line'
    );

    svg.appendChild(
      line
    );
  });
}

window.addEventListener(
  'resize',
  () => {

    const ids =
      [
        ...document.querySelectorAll(
          '.candidate-node.show'
        )
      ]
      .map(
        node =>
          node.dataset.bookId
      );

    drawConnections(
      ids
    );
  }
);


// ------------------------------------------------------------
// 15. 検索開始
// ------------------------------------------------------------

async function startSearch() {
  const query =
    el('queryInput')
      .value
      .trim();

  if (!query) {
    el('queryInput')
      .focus();

    setFocus(
      'search'
    );

    setGuide(
      '<ruby>気<rt>き</rt></ruby>になることを、ひとことでもいいから<ruby>入<rt>い</rt></ruby>れてみてね。',
      '<ruby>入力<rt>にゅうりょく</rt></ruby>してから「<ruby>探<rt>さが</rt></ruby>してみる！」'
    );

    return;
  }

  if (!datasetReady) {
    setGuide(
      '<ruby>図書<rt>としょ</rt></ruby>データをまだ<ruby>読<rt>よ</rt></ruby>みこんでいるよ。',
      'すこしまってね'
    );

    return;
  }

  state.original_input =
    query;

  state.revealToken++;

  el('searchButton')
    .disabled = true;

  el('queryInput')
    .readOnly = true;

  el('graph')
    .innerHTML = '';

  renderJourney();

  setStep(2);

  setFocus(
    'center'
  );

  el('loader')
    .classList
    .add('show');

  setGuide(
    `「${escapeHtml(query)}」から、
    <ruby>冒険<rt>ぼうけん</rt></ruby>の
    <ruby>入口<rt>いりぐち</rt></ruby>になる
    <ruby>本<rt>ほん</rt></ruby>を
    <ruby>探<rt>さが</rt></ruby>しているよ。`,
    'しゅわわわ…… ちょっとまってね'
  );

  logEvent(
    'search_start'
  );

  spawnSparkles(16);

  await wait(
    UX_TIMING.searchMagic
  );

  const entry =
    findEntryBook(query);

  el('loader')
    .classList
    .remove('show');

  if (!entry) {

    el('searchButton')
      .disabled = false;

    el('queryInput')
      .readOnly = false;

    setStep(1);

    setFocus(
      'search'
    );

    setGuide(
      `「${escapeHtml(query)}」に
      ちかい<ruby>本<rt>ほん</rt></ruby>は、
      いまの${bookList.length}<ruby>冊<rt>さつ</rt></ruby>のなかでは
      <ruby>見<rt>み</rt></ruby>つけられなかったよ。`,
      'ほかのことばでも<ruby>試<rt>ため</rt></ruby>してみてね'
    );

    logEvent(
      'no_search_result'
    );

    return;
  }

  state.initial_book_id =
    entry.id;

  state.initial_match_score =
    entry.similarity;

  state.centerBookId =
    entry.id;

  state.path = [
    entry.id
  ];

  logEvent(
    'initial_recommendation',
    {
      initial_book_id:
        entry.id,

      initial_match_score:
        entry.similarity,

      match_method:
        state.match_method
    }
  );

  showCenter(
    entry,
    true
  );

  spawnSparkles(20);
}

// ------------------------------------------------------------
// 16. 本を詳しく見る
// ------------------------------------------------------------

function openDetail(id) {
  const book =
    books[id];

  if (!book) {
    return;
  }

  state.detailBookId =
    id;

  const ndc =
    ndcInfo(book);

  const subjects =
    book.subjects.length
      ? book.subjects
          .slice(0, 4)
          .map(escapeHtml)
          .join('・')
      : plainTextFromHtml(
          ndc.label
        );

  el('detailTitle')
    .innerHTML =
    book.titleHtml;

  el('detailSummary')
    .innerHTML =
    `
      この<ruby>本<rt>ほん</rt></ruby>には、
      「${subjects}」という
      <ruby>手<rt>て</rt></ruby>がかりがあるよ。<br>
      どんなことが<ruby>書<rt>か</rt></ruby>かれているか、
      <ruby>図書館<rt>としょかん</rt></ruby>で
      <ruby>中<rt>なか</rt></ruby>を
      <ruby>見<rt>み</rt></ruby>てみよう。
    `;

  const relation =
    id ===
    state.initial_book_id
      ? 'initial'
      : relationFor(
          state.centerBookId,
          id
        );

  const relationText =
    relation === 'initial'
      ? '<ruby>入口<rt>いりぐち</rt></ruby>の<ruby>本<rt>ほん</rt></ruby>'
      : relationDisplay[relation] ||
        'ことばがちかい';

  el('detailMeta')
    .innerHTML =
    `
      📚
      ${ndc.n}<ruby>類<rt>るい</rt></ruby>
      ${ndc.label}
      の<ruby>本棚<rt>ほんだな</rt></ruby>
      <br>
      ${
        book.ndc
          ? `NDC ${escapeHtml(book.ndc)}`
          : ''
      }
      ${
        relationText
          ? `<br>つながり：${relationText}`
          : ''
      }
    `;

  el('detailModal')
    .classList
    .add('open');

  logEvent(
    'detail_event',
    {
      book_id:
        id,

      center_book_id:
        state.centerBookId,

      relation_type:
        relation
    }
  );

  // いま中央にいる本では「この本からもっと探す」は不要。
  el('detailExpand')
    .style.display =
    id ===
    state.centerBookId
      ? 'none'
      : 'block';

  el('detailExpand')
    .onclick = () => {

      closeDetail();

      expandFrom(id);
    };

  el('detailFinal')
    .onclick = () => {

      closeDetail();

      askFinal(id);
    };
}

function closeDetail() {
  el('detailModal')
    .classList
    .remove('open');
}


// ------------------------------------------------------------
// 17. 関連本を新しい中心にする
// ------------------------------------------------------------

function expandFrom(id) {
  const book =
    books[id];

  if (!book) {
    return;
  }

  const fromBookId =
    state.centerBookId;

  const relation =
    relationFor(
      fromBookId,
      id
    );

  state.revealToken++;

  state.centerBookId =
    id;

  state.previewBookId =
    null;

  state.path.push(id);

  if (
    !state.previewHistory
      .includes(id)
  ) {
    state.previewHistory
      .push(id);
  }

  logEvent(
    'expand_from_book',
    {
      from_book_id:
        fromBookId,

      to_book_id:
        id,

      relation_type:
        relation
    }
  );

  setStep(3);

  setFocus(
    'center'
  );

  setGuide(
    `いいね！<br>
    「${book.titleHtml}」を
    <ruby>新<rt>あたら</rt></ruby>しい
    <ruby>中心<rt>ちゅうしん</rt></ruby>にするよ。`,
    'まずはこの<ruby>本<rt>ほん</rt></ruby>を<ruby>見<rt>み</rt></ruby>てみよう'
  );

  showCenter(
    book,
    false
  );

  spawnSparkles(16);
}


// ------------------------------------------------------------
// 18. 入口の本に戻る
// ------------------------------------------------------------

function returnToInitialBook() {
  const initialId =
    state.initial_book_id;

  if (
    !initialId ||
    !books[initialId]
  ) {
    return;
  }

  if (
    state.centerBookId ===
    initialId
  ) {
    return;
  }

  const fromBookId =
    state.centerBookId;

  state.revealToken++;

  state.centerBookId =
    initialId;

  state.previewBookId =
    null;

  state.path.push(
    initialId
  );

  logEvent(
    'return_to_initial_book',
    {
      from_book_id:
        fromBookId,

      to_book_id:
        initialId
    }
  );

  // 一度見た入口本なので、
  // 説明を最初から繰り返さずすぐ操作できるようにする。
  showCenter(
    books[initialId],
    true,
    true
  );

  renderJourney();

  spawnSparkles(12);
}


// ------------------------------------------------------------
// 19. 最終選択
// ------------------------------------------------------------

function askFinal(id) {
  const book =
    books[id];

  if (!book) {
    return;
  }

  state.detailBookId =
    id;

  el('confirmBook')
    .innerHTML =
    `
      「<strong>${book.titleHtml}</strong>」を、
      さいごの1<ruby>冊<rt>さつ</rt></ruby>に
      えらびます。
    `;

  el('confirmModal')
    .classList
    .add('open');

  el('confirmYes')
    .onclick = () => {
      confirmFinal(id);
    };
}

function confirmFinal(id) {
  const book =
    books[id];

  if (!book) {
    return;
  }

  state.finalBookId =
    id;

  el('confirmModal')
    .classList
    .remove('open');

  setStep(4);

  setFocus(null);

  spawnSparkles(45);

  logEvent(
    'final_choice',
    {
      final_selected_book_id:
        id,

      initial_book_id:
        state.initial_book_id,

      same_as_initial:
        id ===
        state.initial_book_id,

      graph_steps:
        Math.max(
          0,
          state.path.length - 1
        )
    }
  );

  setGuide(
    `やったね！<br>
    「${book.titleHtml}」を
    <ruby>自分<rt>じぶん</rt></ruby>で
    <ruby>見<rt>み</rt></ruby>つけたよ！`,
    'さいごに、<ruby>短<rt>みじか</rt></ruby>い<ruby>質問<rt>しつもん</rt></ruby>に<ruby>答<rt>こた</rt></ruby>えてね'
  );

  setTimeout(
    startSurvey,
    900
  );
}


// ------------------------------------------------------------
// 20. 事後質問
// ------------------------------------------------------------

const surveyFlow = [
  {
    key:
      'new_interest',

    q:
      '<ruby>途中<rt>とちゅう</rt></ruby>で<ruby>見<rt>み</rt></ruby>た<ruby>本<rt>ほん</rt></ruby>のなかで、<ruby>新<rt>あたら</rt></ruby>しく<ruby>気<rt>き</rt></ruby>になった<ruby>本<rt>ほん</rt></ruby>やことばはあった？',

    options: [
      'あった！',
      'なかった'
    ]
  },

  {
    key:
      'final_reason',

    q:
      'さいごの<ruby>本<rt>ほん</rt></ruby>を「これにしよう」と<ruby>思<rt>おも</rt></ruby>った<ruby>決<rt>き</rt></ruby>め<ruby>手<rt>て</rt></ruby>はどれ？',

    options: [
      '<ruby>題名<rt>だいめい</rt></ruby>',
      '<ruby>表紙<rt>ひょうし</rt></ruby>',
      '<ruby>短<rt>みじか</rt></ruby>い<ruby>説明<rt>せつめい</rt></ruby>',
      '<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりのことば',
      '<ruby>本<rt>ほん</rt></ruby>どうしのつながり',
      '<ruby>詳<rt>くわ</rt></ruby>しい<ruby>説明<rt>せつめい</rt></ruby>',
      'なんとなく'
    ]
  }
];

function startSurvey() {
  surveyIndex = 0;

  state.surveyAnswers =
    {};

  showSurvey();
}

function surveyJourneyHtml() {
  const ids =
    [
      ...new Set([
        ...state.path,
        ...state.previewHistory
      ])
    ]
      .filter(
        id => books[id]
      )
      .slice(0, 6);

  if (!ids.length) {
    return '';
  }

  return `
    <div class="survey-memory">

      <div class="survey-memory-title">
        <ruby>途中<rt>とちゅう</rt></ruby>で
        <ruby>見<rt>み</rt></ruby>た
        <ruby>本<rt>ほん</rt></ruby>
      </div>

      <div class="survey-memory-list">

        ${ids
          .map(id => `
            <span class="survey-memory-chip">
              ${books[id].titleHtml}
            </span>
          `)
          .join('')}

      </div>

    </div>
  `;
}

function showSurvey() {
  el('surveyOther')
    .innerHTML = '';

  const item =
    surveyFlow[surveyIndex];

  if (!item) {
    el('surveyModal')
      .classList
      .remove('open');

    showStudyCompletion();

    return;
  }

  el('surveyContext')
    .innerHTML =
    item.key ===
    'new_interest'
      ? surveyJourneyHtml()
      : '';

  el('surveyQuestion')
    .innerHTML =
    item.q;

  el('surveyOptions')
    .innerHTML = '';

  item.options.forEach(
    option => {

      const button =
        document.createElement(
          'button'
        );

      button.className =
        'survey-option';

      button.innerHTML =
        option;

      button.onclick =
        () => {
          answerSurvey(
            item.key,
            plainTextFromHtml(
              option
            )
          );
        };

      el('surveyOptions')
        .appendChild(
          button
        );
    }
  );

  el('surveyModal')
    .classList
    .add('open');
}

function answerSurvey(
  key,
  value
) {
  state.surveyAnswers[key] =
    value;

  logEvent(
    'post_reflection_answer',
    {
      question_key:
        key,

      answer:
        value
    }
  );

  if (
    key ===
      'new_interest' &&
    value ===
      'あった！'
  ) {
    showInterestDetailSurvey();

    return;
  }

  surveyIndex++;

  showSurvey();
}


// ------------------------------------------------------------
// 21. 「新しく気になったもの」の詳細質問
// ------------------------------------------------------------

function showInterestDetailSurvey() {
  el('surveyContext')
    .innerHTML =
    surveyJourneyHtml();

  el('surveyQuestion')
    .innerHTML =
    `
      どの<ruby>本<rt>ほん</rt></ruby>やことばが
      <ruby>新<rt>あたら</rt></ruby>しく
      <ruby>気<rt>き</rt></ruby>になった？<br>
      <ruby>近<rt>ちか</rt></ruby>いものを
      えらんでね。
    `;

  el('surveyOptions')
    .innerHTML = '';

  el('surveyOther')
    .innerHTML = '';

  const ids =
    [
      ...new Set([
        ...state.previewHistory,
        ...state.path.slice(1)
      ])
    ]
      .filter(
        id => books[id]
      )
      .slice(0, 4);

  ids.forEach(id => {

    const button =
      document.createElement(
        'button'
      );

    button.className =
      'survey-option';

    button.innerHTML =
      books[id].titleHtml;

    button.onclick =
      () => {
        saveInterestDetail(
          books[id].title
        );
      };

    el('surveyOptions')
      .appendChild(
        button
      );
  });

  const otherButton =
    document.createElement(
      'button'
    );

  otherButton.className =
    'survey-option';

  otherButton.innerHTML =
    'べつのことを<ruby>書<rt>か</rt></ruby>く';

  otherButton.onclick =
    showInterestTextInput;

  el('surveyOptions')
    .appendChild(
      otherButton
    );
}

function showInterestTextInput() {
  el('surveyOptions')
    .style.display =
    'none';

  el('surveyOther')
    .innerHTML =
    `
      <input
        id="interestText"
        maxlength="80"
        placeholder="気になったことを、ひとこと書いてね"
      >

      <button
        type="button"
        id="interestSave"
      >
        <ruby>答<rt>こた</rt></ruby>える
      </button>
    `;

  el('interestSave')
    .onclick =
    () => {

      const value =
        el('interestText')
          .value
          .trim();

      if (!value) {
        el('interestText')
          .focus();

        return;
      }

      saveInterestDetail(
        value
      );
    };

  el('interestText')
    .focus();
}

function saveInterestDetail(
  value
) {
  state.surveyAnswers
    .new_interest_detail =
    value;

  logEvent(
    'post_reflection_answer',
    {
      question_key:
        'new_interest_detail',

      answer:
        value
    }
  );

  el('surveyOptions')
    .style.display =
    'grid';

  showInterestReasonSurvey();
}

function showInterestReasonSurvey() {
  el('surveyContext')
    .innerHTML =
    surveyJourneyHtml();

  el('surveyQuestion')
    .innerHTML =
    `
      その<ruby>本<rt>ほん</rt></ruby>やことばの、
      どこが<ruby>気<rt>き</rt></ruby>になった？
    `;

  el('surveyOptions')
    .innerHTML = '';

  el('surveyOther')
    .innerHTML = '';

  const options = [
    [
      '<ruby>題名<rt>だいめい</rt></ruby>のことば',
      '題名のことば'
    ],
    [
      '<ruby>本<rt>ほん</rt></ruby>の<ruby>手<rt>て</rt></ruby>がかりのことば',
      '本の手がかりのことば'
    ],
    [
      '<ruby>案内人<rt>あんないにん</rt></ruby>の<ruby>説明<rt>せつめい</rt></ruby>',
      '案内人の説明'
    ],
    [
      '<ruby>本<rt>ほん</rt></ruby>どうしのつながり',
      '本どうしのつながり'
    ],
    [
      'もっと<ruby>知<rt>し</rt></ruby>りたいと<ruby>思<rt>おも</rt></ruby>った',
      'もっと知りたいと思った'
    ]
  ];

  options.forEach(
    ([label, value]) => {

      const button =
        document.createElement(
          'button'
        );

      button.className =
        'survey-option';

      button.innerHTML =
        label;

      button.onclick =
        () => {
          saveInterestReason(
            value
          );
        };

      el('surveyOptions')
        .appendChild(
          button
        );
    }
  );
}

function saveInterestReason(
  value
) {
  state.surveyAnswers
    .new_interest_reason =
    value;

  logEvent(
    'post_reflection_answer',
    {
      question_key:
        'new_interest_reason',

      answer:
        value
    }
  );

  surveyIndex++;

  showSurvey();
}


// ------------------------------------------------------------
// 22. 最後の興味ゲージ用分類
// ------------------------------------------------------------

// 賞状ではNDC10分類をそのまま見せず、
// 子どもが読みやすい大きな分野にまとめる。
const INTEREST_BUCKETS = [
  {
    key:
      'food',

    label:
      '<ruby>食<rt>た</rt></ruby>べ<ruby>物<rt>もの</rt></ruby>・<ruby>料理<rt>りょうり</rt></ruby>'
  },

  {
    key:
      'history',

    label:
      '<ruby>歴史<rt>れきし</rt></ruby>・<ruby>文化<rt>ぶんか</rt></ruby>'
  },

  {
    key:
      'nature',

    label:
      '<ruby>自然<rt>しぜん</rt></ruby>・<ruby>生<rt>い</rt></ruby>き<ruby>物<rt>もの</rt></ruby>'
  },

  {
    key:
      'science',

    label:
      '<ruby>宇宙<rt>うちゅう</rt></ruby>・<ruby>科学<rt>かがく</rt></ruby>'
  },

  {
    key:
      'other',

    label:
      'その<ruby>他<rt>ほか</rt></ruby>'
  }
];

function classifyInterestBucket(
  book
) {
  if (!book) {
    return 'other';
  }

  const title =
    String(
      book.title || ''
    );

  const subjects =
    Array.isArray(
      book.subjects
    )
      ? book.subjects.join(' ')
      : '';

  const text =
    normalizeText(
      `${title} ${subjects}`
    );

  const ndc =
    String(
      book.ndc || ''
    );

  const ndcTop =
    ndc.charAt(0);

  // 題名・subjectsに特徴的な語がある場合はこちらを優先する。
  if (
    /(料理|食|ごはん|弁当|アイス|菓子|野菜|果物|パン|栄養)/.test(
      text
    )
  ) {
    return 'food';
  }

  if (
    /(宇宙|星|銀河|惑星|天文|ブラックホール|相対性|ロケット)/.test(
      text
    )
  ) {
    return 'science';
  }

  if (
    /(生物|動物|植物|海洋|人体|細胞|自然|昆虫|魚|鳥)/.test(
      text
    )
  ) {
    return 'nature';
  }

  if (
    /(歴史|文化|戦争|伝説|人物|江戸|明治|アイヌ|城|昔)/.test(
      text
    )
  ) {
    return 'history';
  }

  // 題名やsubjectsだけで判断できない場合は、
  // NDCの上位分類を補助的に使う。
  if (
    ndcTop === '2' ||
    ndcTop === '3'
  ) {
    return 'history';
  }

  if (
    ndcTop === '4'
  ) {
    return 'science';
  }

  if (
    ndcTop === '5' ||
    ndcTop === '6'
  ) {
    return 'food';
  }

  return 'other';
}


// ------------------------------------------------------------
// 23. ログを興味ゲージ用の点数へ変換
// ------------------------------------------------------------

// 「表示されただけ」の本は点数に入れない。
// 実際に児童が操作した行動だけを使う。
function interestPointForEvent(
  eventType
) {
  const points = {
    initial_recommendation:
      1,

    preview_event:
      1,

    detail_event:
      2,

    expand_from_book:
      3,

    return_to_initial_book:
      2,

    final_choice:
      4
  };

  return (
    points[eventType] ||
    0
  );
}

function makeInterestGaugeData() {
  const scores =
    Object.fromEntries(
      INTEREST_BUCKETS
        .map(item => [
          item.key,
          0
        ])
    );

  state.logs.forEach(
    record => {

      const point =
        interestPointForEvent(
          record.event_type
        );

      if (!point) {
        return;
      }

      let bookId =
        null;

      if (
        record.event_type ===
        'initial_recommendation'
      ) {
        bookId =
          record.initial_book_id;
      }

      if (
        record.event_type ===
          'preview_event' ||
        record.event_type ===
          'detail_event'
      ) {
        bookId =
          record.book_id;
      }

      if (
        record.event_type ===
          'expand_from_book' ||
        record.event_type ===
          'return_to_initial_book'
      ) {
        bookId =
          record.to_book_id;
      }

      if (
        record.event_type ===
        'final_choice'
      ) {
        bookId =
          record.final_selected_book_id;
      }

      const book =
        books[bookId];

      if (!book) {
        return;
      }

      const bucket =
        classifyInterestBucket(
          book
        );

      scores[bucket] +=
        point;
    }
  );

  const maxScore =
    Math.max(
      1,
      ...Object.values(
        scores
      )
    );

  return INTEREST_BUCKETS
    .map(item => ({
      key:
        item.key,

      label:
        item.label,

      score:
        scores[item.key],

      percent:
        Math.round(
          (
            scores[item.key] /
            maxScore
          ) *
          100
        )
    }));
}


// ------------------------------------------------------------
// 24. 興味ゲージHTML
// ------------------------------------------------------------

function interestGaugeHtml(
  gaugeData
) {
  return gaugeData
    .map(item => `
      <div class="interest-gauge-row">

        <div class="interest-gauge-label">

          <span>
            ${item.label}
          </span>

          <strong>
            ${item.score}
          </strong>

        </div>

        <div
          class="interest-gauge-track"
          aria-hidden="true"
        >

          <div
            class="interest-gauge-fill"
            style="width:${item.percent}%"
          ></div>

        </div>

      </div>
    `)
    .join('');
}

function interestReflectionMessage(
  gaugeData
) {
  const ranked =
    [...gaugeData]
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  const active =
    ranked.filter(
      item =>
        item.score > 0
    );

  if (!active.length) {
    return `
      どんな<ruby>本<rt>ほん</rt></ruby>が
      <ruby>気<rt>き</rt></ruby>になるか、
      これからも
      <ruby>探<rt>さが</rt></ruby>してみよう！
    `;
  }

  if (
    active.length >= 4
  ) {
    return `
      いろいろな
      <ruby>分野<rt>ぶんや</rt></ruby>の
      <ruby>本<rt>ほん</rt></ruby>を
      <ruby>見<rt>み</rt></ruby>てみたね！
    `;
  }

  return `
    こんかいは、
    <strong>
      ${ranked[0].label}
    </strong>
    の<ruby>本<rt>ほん</rt></ruby>を
    よく<ruby>見<rt>み</rt></ruby>ていたね！
  `;
}

// ------------------------------------------------------------
// 25. 操作ログから、実際に見た本を取り出す
// ------------------------------------------------------------

// displayed_nodes は「画面に出ただけ」の本なので数えない。
// preview/detail/expand/final_choice など、実際の操作対象を数える。
function getExploredBookIdsFromLogs() {
  const ids = [];

  function addBookId(id) {
    if (
      id &&
      books[id] &&
      !ids.includes(id)
    ) {
      ids.push(id);
    }
  }

  state.logs.forEach(
    record => {

      if (
        record.event_type ===
        'initial_recommendation'
      ) {
        addBookId(
          record.initial_book_id
        );
      }

      if (
        record.event_type ===
          'preview_event' ||
        record.event_type ===
          'detail_event'
      ) {
        addBookId(
          record.book_id
        );
      }

      if (
        record.event_type ===
          'expand_from_book' ||
        record.event_type ===
          'return_to_initial_book'
      ) {
        addBookId(
          record.to_book_id
        );
      }

      if (
        record.event_type ===
        'final_choice'
      ) {
        addBookId(
          record.final_selected_book_id
        );
      }
    }
  );

  // 最後に選んだ本が漏れないようにする。
  addBookId(
    state.finalBookId
  );

  return ids;
}


// ------------------------------------------------------------
// 26. 賞状の探索経路
// ------------------------------------------------------------

function explorationTrailHtml() {
  const path =
    state.path.filter(
      id => books[id]
    );

  if (!path.length) {
    return '';
  }

  const visible =
    path.slice(0, 4);

  const items =
    visible
      .map(
        (id, index) => {

          const book =
            books[id];

          const arrow =
            index === 0
              ? ''
              : `
                <span class="certificate-arrow">
                  ➡
                </span>
              `;

          return `
            ${arrow}

            <span class="certificate-trail-book">
              ${book.titleHtml}
            </span>
          `;
        }
      )
      .join('');

  const more =
    path.length >
    visible.length
      ? `
        <span class="certificate-more">
          ほか
          ${
            path.length -
            visible.length
          }
          <ruby>冊<rt>さつ</rt></ruby>
        </span>
      `
      : '';

  return `
    <div class="certificate-trail">

      <div class="certificate-trail-title">
        🧵
        <ruby>本<rt>ほん</rt></ruby>を
        たどった
        <ruby>道<rt>みち</rt></ruby>
      </div>

      <div class="certificate-trail-list">
        ${items}
        ${more}
      </div>

    </div>
  `;
}


// ------------------------------------------------------------
// 27. 最後の賞状を表示
// ------------------------------------------------------------

function showStudyCompletion() {
  const book =
    books[state.finalBookId];

  if (!book) {
    return;
  }

  const ndc =
    ndcInfo(book);

  const graph =
    el('graph');

  const exploredIds =
    getExploredBookIdsFromLogs();

  const gaugeData =
    makeInterestGaugeData();

  const subjects =
    book.subjects.slice(
      0,
      3
    );

  graph.innerHTML = `
    <div class="finish-node">

      <section class="finish-card">

        <header class="certificate-header">

          <div
            class="certificate-star"
            aria-hidden="true"
          >
            ★
          </div>

          <div>

            <div class="certificate-kicker">
              <ruby>本<rt>ほん</rt></ruby>の
              たんけんしょう
            </div>

            <h2>
              きみの
              <ruby>本<rt>ほん</rt></ruby>さがしの
              <ruby>記録<rt>きろく</rt></ruby>
            </h2>

          </div>

          <div
            class="certificate-star"
            aria-hidden="true"
          >
            ★
          </div>

        </header>


        <div class="certificate-grid">

          <!-- 左側：最後に選んだ本 -->
          <section class="certificate-book-panel">

            <h3>
              📘
              さいごにえらんだ
              <ruby>本<rt>ほん</rt></ruby>
            </h3>

            <div class="certificate-book-main">

              ${coverHtml(book)}

              <div class="certificate-book-info">

                <div class="certificate-book-title">
                  ${book.titleHtml}
                </div>

                ${
                  book.isbn
                    ? `
                      <div class="certificate-isbn">
                        ISBN
                        ${escapeHtml(book.isbn)}
                      </div>
                    `
                    : ''
                }

                ${
                  subjects.length
                    ? `
                      <div class="certificate-subject-title">
                        この
                        <ruby>本<rt>ほん</rt></ruby>の
                        <ruby>手<rt>て</rt></ruby>がかり
                      </div>

                      <div class="certificate-subjects">

                        ${subjects
                          .map(
                            subject => `
                              <span>
                                ${escapeHtml(subject)}
                              </span>
                            `
                          )
                          .join('')}

                      </div>
                    `
                    : ''
                }

              </div>

            </div>


            <div class="finish-shelf">

              📚

              <strong>
                ${ndc.n}
                <ruby>類<rt>るい</rt></ruby>
                ${ndc.label}
              </strong>

              の
              <ruby>本棚<rt>ほんだな</rt></ruby>

              <br>

              <small>
                NDC
                ${escapeHtml(
                  String(
                    book.ndc ||
                    ndc.n
                  )
                )}
              </small>

            </div>


            <div class="finish-go-shelf">

              ➡
              この
              <ruby>画面<rt>がめん</rt></ruby>をもって、

              <ruby>図書館<rt>としょかん</rt></ruby>の

              <strong>
                ${ndc.n}
                <ruby>類<rt>るい</rt></ruby>
                ${ndc.label}
              </strong>

              のコーナーへ
              <ruby>行<rt>い</rt></ruby>ってみよう！

            </div>

          </section>


          <!-- 右側：ログから作る興味ゲージ -->
          <section class="certificate-reflection-panel">

            <h3>
              ✨
              たんけんのふりかえり
            </h3>

            <div class="reflection-subtitle">
              こんかい、
              よく
              <ruby>見<rt>み</rt></ruby>た
              <ruby>分野<rt>ぶんや</rt></ruby>
            </div>

            <div
              class="interest-gauge-list"
              aria-label="今回よく見た分野"
            >
              ${interestGaugeHtml(
                gaugeData
              )}
            </div>


            <div class="reflection-message">

              ${interestReflectionMessage(
                gaugeData
              )}

              <br>

              <small>
                ${exploredIds.length}
                <ruby>冊<rt>さつ</rt></ruby>の
                <ruby>本<rt>ほん</rt></ruby>を
                <ruby>見<rt>み</rt></ruby>ながら
                たどったよ。
              </small>

            </div>

          </section>

        </div>


        ${explorationTrailHtml()}


        <div class="certificate-footer">

          <span class="finish-camera">
            📷
            この
            <ruby>画面<rt>がめん</rt></ruby>を
            スクショしてね
          </span>

          <span class="certificate-finish-message">
            これで
            <ruby>今回<rt>こんかい</rt></ruby>の
            <ruby>案内<rt>あんない</rt></ruby>は
            おしまい！
          </span>

        </div>

      </section>

    </div>
  `;


  const finishNode =
    graph.querySelector(
      '.finish-node'
    );

  if (finishNode) {
    trySetCover(
      finishNode,
      book
    );
  }


  // 終了画面では右側パネルを隠す。
  el('journeyPanel')
    .hidden = true;

  setStep(4);

  setFocus(null);

  document.body
    .classList
    .add(
      'study-complete'
    );

  el('searchButton')
    .disabled = true;

  el('queryInput')
    .readOnly = true;


  setGuide(
    `
      <strong>
        きみの
        <ruby>本<rt>ほん</rt></ruby>さがしの
        <ruby>記録<rt>きろく</rt></ruby>が
        できたよ！
      </strong>
      <br>

      この
      <ruby>画面<rt>がめん</rt></ruby>を
      スクショして、

      <strong>
        ${ndc.n}
        <ruby>類<rt>るい</rt></ruby>
        ${ndc.label}
      </strong>

      の
      <ruby>本棚<rt>ほんだな</rt></ruby>へ
      <ruby>行<rt>い</rt></ruby>ってみよう！
    `,
    ''
  );


  spawnSparkles(50);


  logEvent(
    'study_complete',
    {
      final_selected_book_id:
        book.id,

      final_selected_isbn:
        book.isbn,

      shelf_ndc_top:
        ndc.n,

      shelf_label:
        plainTextFromHtml(
          ndc.label
        ),

      explored_book_count:
        exploredIds.length,

      interest_gauge:
        gaugeData.map(
          item => ({
            key:
              item.key,

            score:
              item.score
          })
        )
    }
  );


  // 研究用ログを最後に保存する。
  // ブラウザのダウンロードとしてJSONを出す。
  setTimeout(
    downloadLog,
    700
  );
}


// ------------------------------------------------------------
// 28. キャンセル操作
// ------------------------------------------------------------

function cancelFinal() {
  el('confirmModal')
    .classList
    .remove('open');
}

function closeSurvey() {
  el('surveyModal')
    .classList
    .remove('open');
}


// ------------------------------------------------------------
// 29. キラキラ演出
// ------------------------------------------------------------

function spawnSparkles(
  count = 12
) {
  const layer =
    el('particleLayer');

  if (!layer) {
    return;
  }

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const particle =
      document.createElement(
        'span'
      );

    particle.className =
      'particle';

    particle.style.left =
      `${15 + Math.random() * 70}%`;

    particle.style.top =
      `${25 + Math.random() * 55}%`;

    particle.style.animationDelay =
      `${Math.random() * 0.35}s`;

    layer.appendChild(
      particle
    );

    setTimeout(
      () => {
        particle.remove();
      },
      1800
    );
  }
}


// ------------------------------------------------------------
// 30. 初期イベント設定
// ------------------------------------------------------------

function bindEvents() {

  el('startExperimentButton')
    .addEventListener(
      'click',
      startExperiment
    );


  el('participantInput')
    .addEventListener(
      'keydown',
      event => {

        if (
          event.key ===
          'Enter'
        ) {
          startExperiment();
        }
      }
    );


  el('searchButton')
    .addEventListener(
      'click',
      startSearch
    );


  el('queryInput')
    .addEventListener(
      'keydown',
      event => {

        if (
          event.key ===
          'Enter'
        ) {
          startSearch();
        }
      }
    );


  el('speechNext')
    .addEventListener(
      'click',
      continueDialogue
    );


  // 吹き出し全体を押して進めるのではなく、
  // 大きな「つぎへ▼」だけで進む。
  // 児童が本文を読む途中で誤って進めないため。


  el('returnToStartButton')
    .addEventListener(
      'click',
      returnToInitialBook
    );


  el('detailClose')
    .addEventListener(
      'click',
      closeDetail
    );


  el('confirmNo')
    .addEventListener(
      'click',
      cancelFinal
    );


  // モーダル背景を押しただけでは閉じない。
  // 誤操作を防ぐため、閉じるボタンを使う。
}


// ------------------------------------------------------------
// 31. ページ初期化
// ------------------------------------------------------------

async function initializeApp() {

  bindEvents();


  // 参加者用画面を操作する前に
  // 図書データを読み込む。
  el('startExperimentButton')
    .disabled = true;


  setDatasetStatus(
    '図書データを読み込んでいます……'
  );


  await loadBookDataset();


  // 最初は実験者が参加者IDを入力する。
  el('experimentStartModal')
    .classList
    .add('open');


  el('participantInput')
    .value = 'P001';


  if (datasetReady) {

    setGuide(
      '<ruby>準備<rt>じゅんび</rt></ruby>ができたよ！',
      '<ruby>参加者<rt>さんかしゃ</rt></ruby>IDを<ruby>確認<rt>かくにん</rt></ruby>して、<ruby>実験<rt>じっけん</rt></ruby>を<ruby>始<rt>はじ</rt></ruby>めてね'
    );

  } else {

    setGuide(
      '<ruby>図書<rt>としょ</rt></ruby>データを<ruby>読<rt>よ</rt></ruby>みこめなかったよ。',
      'Live Server または HTTP サーバーで<ruby>開<rt>ひら</rt></ruby>いてね'
    );
  }
}


// ------------------------------------------------------------
// 32. 起動
// ------------------------------------------------------------

document.addEventListener(
  'DOMContentLoaded',
  initializeApp
);
