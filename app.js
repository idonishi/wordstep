const DB_NAME = 'wordstep-db';
const DB_VERSION = 1;
const WORDS_URL = './public/data/words.json';
const app = document.getElementById('app');
const installButton = document.getElementById('installButton');
let db;
let words = [];
let deferredInstallPrompt = null;
let activeSession = null;
let currentView = 'home';

const MODES = {
  enja: { label: '英語 → 日本語', icon: 'Aあ', description: '英語を見て意味を選ぶ', type: 'choice' },
  jaen: { label: '日本語 → 英語', icon: 'あA', description: '意味を見て英語を入力する', type: 'input' },
  listening: { label: '音声 → 意味', icon: '♫', description: '音声を聞いて意味を選ぶ', type: 'choice' },
  spelling: { label: 'スペル入力', icon: '✎', description: '意味を見てスペルを入力する', type: 'input' }
};

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains('words')) d.createObjectStore('words', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('answers')) d.createObjectStore('answers', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function storeRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(null); return; }
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let req;
    try { req = action(store); } catch (e) { reject(e); return; }
    if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
    else { tx.oncomplete = () => resolve(null); tx.onerror = () => reject(tx.error); }
  });
}
async function getAll(storeName) { return storeRequest(storeName, 'readonly', s => s.getAll()) || []; }
async function getOne(storeName, key) { return storeRequest(storeName, 'readonly', s => s.get(key)); }
async function putOne(storeName, value) { if (db) await storeRequest(storeName, 'readwrite', s => s.put(value)); }
async function deleteOne(storeName, key) { if (db) await storeRequest(storeName, 'readwrite', s => s.delete(key)); }
async function clearStore(storeName) { if (db) await storeRequest(storeName, 'readwrite', s => s.clear()); }

// localStorage is a fallback for browsers where IndexedDB is unavailable.
const fallback = {
  get(key, defaultValue) { try { return JSON.parse(localStorage.getItem(key)) ?? defaultValue; } catch { return defaultValue; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('端末の保存容量が不足している可能性があります。'); } }
};
async function allProgress() {
  if (db) return await getAll('progress');
  return fallback.get('progress', []);
}
async function saveProgress(p) {
  if (db) await putOne('progress', p);
  else { const all = fallback.get('progress', []); const i = all.findIndex(x => x.key === p.key); if (i >= 0) all[i] = p; else all.push(p); fallback.set('progress', all); }
}
async function allSessions() {
  if (db) return await getAll('sessions');
  return fallback.get('sessions', []);
}
async function saveSession(s) {
  if (db) await putOne('sessions', s);
  else { const all = fallback.get('sessions', []); all.push(s); fallback.set('sessions', all); }
}
async function allAnswers() {
  if (db) return await getAll('answers');
  return fallback.get('answers', []);
}
async function saveAnswer(a) {
  if (db) await putOne('answers', a);
  else { const all = fallback.get('answers', []); all.push(a); fallback.set('answers', all); }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function normalized(text) { return String(text ?? '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[.!?。！？,，]/g, '').replace(/\s+/g, ' '); }
function formatPercent(n) { return `${Math.round(n || 0)}%`; }
function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function dateLabel(timestamp) { if (!timestamp) return '未学習'; return new Date(timestamp).toLocaleDateString('ja-JP', { month:'short', day:'numeric' }); }
function progressKey(wordId, mode) { return `${wordId}::${mode}`; }
function getProgressMap(progressList) { return new Map(progressList.map(p => [p.key, p])); }
function toast(message) {
  const old = document.querySelector('.toast'); if (old) old.remove();
  const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.appendChild(node);
  setTimeout(() => node.remove(), 2800);
}
function speak(text) {
  if (!('speechSynthesis' in window)) { toast('このブラウザでは音声読み上げに対応していません。'); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US'; utterance.rate = 0.88;
  window.speechSynthesis.speak(utterance);
}
function masteryLabel(p) {
  if (!p || !p.totalAttempts) return '未学習';
  if (p.consecutiveCorrect >= 4) return '習得';
  if (p.consecutiveCorrect >= 1 && p.totalCorrect > 0) return '学習中';
  return '復習中';
}
async function seedWords() {
  if (!db) return;
  const existing = await getAll('words');
  if (existing.length !== words.length) {
    await clearStore('words');
    for (const word of words) await putOne('words', word);
  }
}
async function boot() {
  try {
    db = await openDB();
    const response = await fetch(WORDS_URL);
    if (!response.ok) throw new Error('単語データを読み込めませんでした。');
    words = await response.json();
    if (!Array.isArray(words) || words.length !== 500) throw new Error(`単語データの件数が想定と異なります（${words.length}語）。`);
    await seedWords();
    renderHome();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(() => toast('オフライン機能の登録に失敗しました。HTTPS環境で再確認してください。'));
    }
  } catch (error) {
    app.innerHTML = `<section class="panel"><h2>起動できませんでした</h2><p class="muted">${escapeHtml(error.message || '単語データの読み込みに失敗しました。')}</p><p>ZIPを展開したフォルダーでローカルサーバーを起動してから開いてください。<code>file://</code> で直接開くと動作しません。</p></section>`;
  }
}
async function renderHome() {
  currentView = 'home'; activeSession = null;
  const [progress, sessions, answers] = await Promise.all([allProgress(), allSessions(), allAnswers()]);
  const pmap = getProgressMap(progress);
  const attempts = answers.length; const correct = answers.filter(a => a.isCorrect).length;
  const todayAnswers = answers.filter(a => a.day === todayKey());
  const todayCorrect = todayAnswers.filter(a => a.isCorrect).length;
  const masteredIds = new Set(progress.filter(p => p.mode === 'enja' && p.consecutiveCorrect >= 4).map(p => p.wordId));
  const weakIds = new Set(progress.filter(p => p.totalAttempts && (p.consecutiveCorrect === 0 || p.nextReviewAt <= Date.now())).map(p => p.wordId));
  const lastTen = answers.slice(-10); const lastTenCorrect = lastTen.filter(a => a.isCorrect).length;
  app.innerHTML = `
    <section class="hero"><div class="eyebrow">DAILY VOCABULARY PRACTICE</div><h1>英語を、少しずつ<br>使える知識に。</h1><p>日常会話や動画・配信で見かける英語を、10問ずつ練習。苦手な表現を見つけて、忘れる前に復習しましょう。</p><div class="hero-actions"><button class="button primary" data-action="choose-mode">学習を始める　→</button><button class="button secondary" data-action="start-review">苦手単語を復習</button></div></section>
    <section class="stats-grid">
      <div class="stat-card"><div class="stat-label">収録語彙</div><div class="stat-value">${words.length}<span class="muted" style="font-size:13px"> 語</span></div><div class="stat-note">日常会話・海外コンテンツ</div></div>
      <div class="stat-card"><div class="stat-label">今日の回答</div><div class="stat-value">${todayAnswers.length}<span class="muted" style="font-size:13px"> 問</span></div><div class="stat-note">正解 ${todayCorrect} 問</div></div>
      <div class="stat-card"><div class="stat-label">累計正答率</div><div class="stat-value">${formatPercent(attempts ? correct/attempts*100 : 0)}</div><div class="stat-note">${attempts} 回回答</div></div>
      <div class="stat-card"><div class="stat-label">復習候補</div><div class="stat-value">${weakIds.size}<span class="muted" style="font-size:13px"> 語</span></div><div class="stat-note">忘れやすい単語を優先</div></div>
    </section>
    <div class="section-heading"><div><h2>学習モード</h2><p>目的に合わせてトレーニング</p></div></div>
    <section class="mode-grid">${Object.entries(MODES).map(([key,m])=>`<button class="mode-card" data-mode="${key}"><span class="mode-icon">${m.icon}</span><span><strong>${m.label}</strong><p>${m.description}</p></span></button>`).join('')}</section>
    <section class="panel"><div class="section-heading" style="margin:0 0 13px"><div><h2>学習の進み具合</h2><p>英語 → 日本語モードの習熟状況</p></div><strong>${masteredIds.size} / ${words.length}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${masteredIds.size/words.length*100}%"></div></div><div class="settings-row"><div><strong>直近10問の正答率</strong><p>最近の学習の調子を確認</p></div><strong>${lastTen.length ? formatPercent(lastTenCorrect/lastTen.length*100) : '—'}</strong></div><div class="settings-row"><div><strong>学習セッション</strong><p>完了した学習回数</p></div><strong>${sessions.length} 回</strong></div><div class="toolbar"><button class="button secondary small-button" data-action="words">単語一覧を見る</button><button class="button secondary small-button" data-action="stats">学習記録を見る</button><button class="button secondary small-button" data-action="settings">設定・バックアップ</button></div></section>
    <div class="notice">音声は試作版のため、ブラウザーの英語読み上げ機能を利用します。音声の利用可否やオフライン再生は端末・ブラウザーに依存します。</div>`;
}
function chooseMode(mode, reviewOnly=false) {
  if (!MODES[mode]) mode = 'enja';
  startSession(mode, reviewOnly);
}
async function startSession(mode, reviewOnly=false) {
  const progress = await allProgress(); const pmap = getProgressMap(progress);
  let pool = [...words];
  if (reviewOnly) {
    pool = pool.filter(w => {
      const p = pmap.get(progressKey(w.id, mode));
      return p && p.totalAttempts && (p.consecutiveCorrect === 0 || p.nextReviewAt <= Date.now());
    });
    if (!pool.length) {
      pool = words.filter(w => { const p = pmap.get(progressKey(w.id, mode)); return p && p.totalAttempts && p.consecutiveCorrect < 4; });
    }
    if (!pool.length) { toast('復習対象がありません。通常学習から始めましょう。'); renderHome(); return; }
    pool = shuffle(pool).slice(0, 10);
  } else {
    const due = pool.filter(w => { const p = pmap.get(progressKey(w.id, mode)); return p && p.totalAttempts && p.nextReviewAt <= Date.now(); });
    const newOrWeak = pool.filter(w => { const p = pmap.get(progressKey(w.id, mode)); return !p || !p.totalAttempts || p.consecutiveCorrect < 4; });
    pool = shuffle([...due, ...shuffle(newOrWeak.filter(w => !due.some(d => d.id === w.id))).slice(0, 25)]);
    pool = pool.slice(0, 10);
  }
  activeSession = { id: `s-${Date.now()}-${Math.random().toString(16).slice(2,7)}`, mode, reviewOnly, startedAt: Date.now(), questions: pool, index: 0, results: [], locked: false };
  renderQuestion();
}
function getMeaning(word) { return (word.meanings || []).join(' / '); }
function getQuestionPrompt(word, mode) {
  if (mode === 'enja') return `<div class="word-type">英単語の意味を選んでください</div><div class="prompt-word">${escapeHtml(word.word)}</div><button class="listen-button" data-action="speak-current">▶ 発音を聞く</button>`;
  if (mode === 'jaen') return `<div class="word-type">次の意味に合う英語を入力してください</div><div class="prompt-jp">${escapeHtml(getMeaning(word))}</div>`;
  if (mode === 'listening') return `<div class="word-type">音声を聞いて、意味を選んでください</div><div class="prompt-word">♫</div><button class="listen-button" data-action="speak-current">▶ 音声を再生</button><p class="muted" style="font-size:12px;margin-top:12px">答えを選ぶまでは英語の文字を表示しません</p>`;
  const hint = word.word.split(' ').map(part => part.length < 2 ? part : part[0] + '＿'.repeat(Math.min(part.length - 1, 8))).join('　');
  return `<div class="word-type">意味を見て、スペルを完成させてください</div><div class="prompt-jp">${escapeHtml(getMeaning(word))}</div><div class="prompt-word" style="font-size:clamp(25px,6vw,38px);letter-spacing:.08em">${escapeHtml(hint)}</div>`;
}
function choiceOptions(word) {
  const distractors = shuffle(words.filter(w => w.id !== word.id && getMeaning(w) !== getMeaning(word))).slice(0, 3);
  return shuffle([word, ...distractors]);
}
function renderQuestion() {
  currentView = 'quiz';
  const s = activeSession; if (!s) { renderHome(); return; }
  if (s.index >= s.questions.length) { finishSession(); return; }
  s.locked = false;
  const word = s.questions[s.index]; s.currentWord = word;
  const mode = MODES[s.mode];
  const prompt = getQuestionPrompt(word, s.mode);
  let answerArea = '';
  if (mode.type === 'choice') {
    answerArea = `<div class="answer-grid">${choiceOptions(word).map(opt=>`<button class="answer-option" data-answer-id="${opt.id}">${escapeHtml(getMeaning(opt))}</button>`).join('')}</div>`;
  } else {
    answerArea = `<form id="answerForm" class="input-row"><input class="answer-input" id="answerInput" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="英語を入力…" aria-label="英語の回答" required><button class="button primary" type="submit">回答</button></form>`;
  }
  app.innerHTML = `<div class="progress-head"><button class="button secondary small-button" data-action="exit-quiz">← 終了</button><span>${s.reviewOnly ? '苦手単語の復習' : mode.label}</span><strong>${s.index+1} / ${s.questions.length}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${(s.index/s.questions.length)*100}%"></div></div><section class="word-card">${prompt}</section><section class="question-card" style="padding:17px">${answerArea}<div id="feedback" class="hidden"></div><div class="quiz-actions"><span class="muted" style="font-size:12px;align-self:center">回答は端末内に保存されます</span><button class="button primary hidden" id="nextButton">次の問題 →</button></div></section>`;
  if (s.mode === 'listening') setTimeout(() => speak(word.word), 350);
  const input = document.getElementById('answerInput'); if (input) input.focus({preventScroll:true});
}
function isCorrectInput(value, word) {
  const expected = [word.word, ...(word.acceptedAnswers || [])].map(normalized);
  return expected.includes(normalized(value));
}
async function submitAnswer(answer, selectedId=null) {
  const s = activeSession; if (!s || s.locked) return;
  const word = s.currentWord; const mode = s.mode;
  let isCorrect = false;
  if (selectedId) isCorrect = selectedId === word.id;
  else if (mode === 'jaen' || mode === 'spelling') isCorrect = isCorrectInput(answer, word);
  if (mode === 'jaen' || mode === 'spelling') {
    const input = document.getElementById('answerInput'); if (input) input.disabled = true;
    const formButton = document.querySelector('#answerForm button'); if (formButton) formButton.disabled = true;
  }
  s.locked = true;
  const now = Date.now();
  const answerRecord = { id:`a-${now}-${Math.random().toString(16).slice(2,7)}`, sessionId:s.id, wordId:word.id, mode, isCorrect, response:answer || selectedId || '', answeredAt:now, day:todayKey() };
  s.results.push({word, isCorrect, answer:answer || '', answerRecord});
  await saveAnswer(answerRecord);
  const key = progressKey(word.id, mode); const old = (await allProgress()).find(p=>p.key===key) || {key,wordId:word.id,mode,totalAttempts:0,totalCorrect:0,consecutiveCorrect:0,lastAnsweredAt:null,nextReviewAt:0,masteryLevel:'未学習'};
  old.totalAttempts += 1; old.totalCorrect += isCorrect ? 1 : 0; old.consecutiveCorrect = isCorrect ? old.consecutiveCorrect + 1 : 0; old.lastAnsweredAt = now;
  const intervals = [1,3,7,14,30]; const days = isCorrect ? intervals[Math.min(Math.max(old.consecutiveCorrect-1,0), intervals.length-1)] : 1;
  old.nextReviewAt = now + days*24*60*60*1000; old.masteryLevel = masteryLabel(old); await saveProgress(old);
  document.querySelectorAll('.answer-option').forEach(btn=>{
    btn.disabled = true;
    if (btn.dataset.answerId === word.id) btn.classList.add('correct');
    else if (selectedId && btn.dataset.answerId === selectedId && !isCorrect) btn.classList.add('incorrect');
  });
  const feedback = document.getElementById('feedback'); feedback.className = `feedback ${isCorrect?'good':'bad'}`;
  feedback.innerHTML = `<strong>${isCorrect?'正解！':'不正解'}</strong><div><b>${escapeHtml(word.word)}</b> — ${escapeHtml(getMeaning(word))}</div><div class="example-box"><div class="example-en">${escapeHtml(word.exampleEn)}</div><div>${escapeHtml(word.exampleJa)}</div><div class="toolbar"><button class="listen-button" data-action="speak-current">▶ 発音を聞く</button></div></div>`;
  document.getElementById('nextButton').classList.remove('hidden');
  document.querySelector('.progress-fill').style.width = `${((s.index+1)/s.questions.length)*100}%`;
}
async function finishSession() {
  const s = activeSession; if (!s) { renderHome(); return; }
  const correct = s.results.filter(r=>r.isCorrect).length;
  const session = { id:s.id, mode:s.mode, reviewOnly:s.reviewOnly, startedAt:s.startedAt, completedAt:Date.now(), questionCount:s.results.length, correctCount:correct, accuracy:s.results.length?correct/s.results.length*100:0 };
  await saveSession(session);
  currentView = 'result';
  const wrong = s.results.filter(r=>!r.isCorrect);
  app.innerHTML = `<div class="section-heading"><div><div class="eyebrow">SESSION COMPLETE</div><h1>おつかれさま！</h1><p class="muted">${escapeHtml(MODES[s.mode].label)}の学習結果</p></div></div><section class="result-card"><div class="score-ring" style="--score:${session.accuracy}%"><span>${formatPercent(session.accuracy)}</span></div><h2>${correct} / ${s.results.length} 問正解</h2><p class="muted">${wrong.length ? `${wrong.length}語を復習候補に追加しました。` : '今回は全問正解です！次は別のモードにも挑戦してみましょう。'}</p><div class="hero-actions" style="justify-content:center"><button class="button primary" data-action="retry-wrong" ${wrong.length?'':'disabled'}>間違えた単語を復習</button><button class="button secondary" data-action="choose-mode">別の学習をする</button></div></section>${wrong.length?`<section class="panel"><h2>今回間違えた単語</h2><div class="wrong-list">${wrong.map(r=>`<div class="wrong-item"><div><strong>${escapeHtml(r.word.word)}</strong><small>${escapeHtml(getMeaning(r.word))}</small></div><button class="listen-button" data-speak="${escapeHtml(r.word.word)}">▶ 聞く</button></div>`).join('')}</div></section>`:''}<div class="toolbar"><button class="button secondary" data-action="home">ホームに戻る</button><button class="button secondary" data-action="stats">学習記録を見る</button></div>`;
}
async function renderWords(query='') {
  currentView='words'; const progress=await allProgress(); const pmap=getProgressMap(progress); const q=normalized(query);
  const list=words.filter(w=>!q || normalized(w.word).includes(q) || normalized(getMeaning(w)).includes(q)).slice(0,150);
  app.innerHTML=`<div class="section-heading"><div><div class="eyebrow">VOCABULARY</div><h1>単語一覧</h1><p class="muted">${words.length}語を収録。英語・日本語で検索できます。</p></div><button class="button secondary small-button" data-action="home">← ホーム</button></div><input class="search-input" id="wordSearch" placeholder="英単語・日本語の意味を検索…" value="${escapeHtml(query)}"><div class="category-line"><span class="badge">日常会話</span><span class="badge">海外コンテンツ</span><span class="badge">熟語・口語表現</span></div><div class="word-list" style="margin-top:14px">${list.map(w=>{const ps=progress.filter(p=>p.wordId===w.id);const best=ps.sort((a,b)=>b.consecutiveCorrect-a.consecutiveCorrect)[0];return `<div class="word-row"><div class="word-row-main"><strong>${escapeHtml(w.word)}</strong><small>${escapeHtml(getMeaning(w))}</small><small>${escapeHtml(w.exampleEn)}<br>${escapeHtml(w.exampleJa)}</small></div><div style="display:grid;gap:7px;justify-items:end"><span class="badge ${best&&best.consecutiveCorrect===0?'weak':''}">${best?masteryLabel(best):'未学習'}</span><button class="listen-button" data-speak="${escapeHtml(w.word)}">▶ 聞く</button></div></div>`}).join('')||'<div class="empty-state">該当する単語がありません。</div>'}</div>${words.length>list.length?`<p class="muted" style="font-size:12px;text-align:center">検索結果の先頭150件を表示しています。さらに絞り込んでください。</p>`:''}`;
  document.getElementById('wordSearch').addEventListener('input',e=>{const pos=e.target.selectionStart; const value=e.target.value; renderWords(value).then(()=>{const input=document.getElementById('wordSearch');input.focus();input.setSelectionRange(pos,pos);});});
}
async function renderStats() {
  currentView='stats'; const [answers,sessions,progress]=await Promise.all([allAnswers(),allSessions(),allProgress()]);
  const totalCorrect=answers.filter(a=>a.isCorrect).length; const recent=answers.slice(-30); const recentCorrect=recent.filter(a=>a.isCorrect).length;
  const byMode=Object.keys(MODES).map(mode=>{const list=answers.filter(a=>a.mode===mode);return {mode,count:list.length,correct:list.filter(a=>a.isCorrect).length};});
  const due=progress.filter(p=>p.totalAttempts && p.nextReviewAt<=Date.now()).length;
  const recentSessions=sessions.slice(-12).reverse();
  app.innerHTML=`<div class="section-heading"><div><div class="eyebrow">YOUR PROGRESS</div><h1>学習記録</h1><p class="muted">学習データはこの端末に保存されています。</p></div><button class="button secondary small-button" data-action="home">← ホーム</button></div><section class="stats-grid"><div class="stat-card"><div class="stat-label">累計回答</div><div class="stat-value">${answers.length}</div><div class="stat-note">全モード合計</div></div><div class="stat-card"><div class="stat-label">累計正答率</div><div class="stat-value">${formatPercent(answers.length?totalCorrect/answers.length*100:0)}</div><div class="stat-note">正解 ${totalCorrect} 問</div></div><div class="stat-card"><div class="stat-label">直近30問</div><div class="stat-value">${formatPercent(recent.length?recentCorrect/recent.length*100:0)}</div><div class="stat-note">最近の調子</div></div><div class="stat-card"><div class="stat-label">復習予定</div><div class="stat-value">${due}</div><div class="stat-note">モード別記録</div></div></section><section class="panel"><h2>モード別の成績</h2>${byMode.map(m=>`<div class="settings-row"><div><strong>${MODES[m.mode].label}</strong><p>${m.count} 回回答・正解 ${m.correct} 回</p></div><strong>${formatPercent(m.count?m.correct/m.count*100:0)}</strong></div>`).join('')}</section><section class="panel"><h2>最近の学習</h2>${recentSessions.length?recentSessions.map(s=>`<div class="settings-row"><div><strong>${escapeHtml(MODES[s.mode]?.label||s.mode)}${s.reviewOnly?'（復習）':''}</strong><p>${dateLabel(s.completedAt)} ・ ${s.questionCount}問</p></div><strong>${formatPercent(s.accuracy)}</strong></div>`).join(''):'<div class="empty-state">まだ学習記録がありません。最初の10問に挑戦しましょう。</div>'}</section><div class="toolbar"><button class="button secondary" data-action="export">データをバックアップ</button><button class="button secondary" data-action="home">ホームに戻る</button></div>`;
}
async function renderSettings() {
  currentView='settings'; const [progress,sessions,answers]=await Promise.all([allProgress(),allSessions(),allAnswers()]);
  app.innerHTML=`<div class="section-heading"><div><div class="eyebrow">SETTINGS</div><h1>設定・バックアップ</h1><p class="muted">端末内の学習データを管理します。</p></div><button class="button secondary small-button" data-action="home">← ホーム</button></div><section class="panel"><div class="settings-row"><div><strong>収録単語数</strong><p>アプリに同梱されている単語データ</p></div><strong>${words.length}語</strong></div><div class="settings-row"><div><strong>保存方式</strong><p>IndexedDB（非対応時はlocalStorage）</p></div><span class="badge">端末内</span></div><div class="settings-row"><div><strong>オフライン学習</strong><p>初回オンライン起動後にアプリ本体と単語データをキャッシュ</p></div><span class="badge">PWA</span></div><div class="settings-row"><div><strong>音声</strong><p>ブラウザーの英語読み上げ機能を利用。オフライン再生は保証されません。</p></div><span class="badge">試作</span></div></section><section class="panel"><h2>データの管理</h2><p class="muted" style="line-height:1.7">バックアップには回答履歴、学習セッション、習熟度が含まれます。端末変更やブラウザーデータ削除に備えて、定期的に保存してください。</p><div class="toolbar"><button class="button primary" data-action="export">バックアップを書き出す（JSON）</button><button class="button secondary" data-action="import">バックアップを復元する</button><input type="file" id="importFile" accept="application/json,.json" hidden></div></section><section class="panel"><h2>学習データの初期化</h2><p class="muted" style="line-height:1.7">学習履歴・正答率・習熟度をすべて削除します。収録単語は削除されません。</p><button class="button danger" data-action="reset">学習記録をすべて削除</button></section><div class="notice">現在は複数端末間の同期機能はありません。バックアップファイルは安全な場所に保管してください。</div>`;
}
async function exportData() {
  const payload={app:'WordStep',version:1,exportedAt:new Date().toISOString(),progress:await allProgress(),sessions:await allSessions(),answers:await allAnswers()};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`wordstep-backup-${todayKey()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); toast('バックアップファイルを書き出しました。');
}
async function importData(file) {
  try {
    const data=JSON.parse(await file.text());
    if (!data || !Array.isArray(data.progress) || !Array.isArray(data.sessions) || !Array.isArray(data.answers)) throw new Error('バックアップ形式が正しくありません。');
    if (!confirm(`バックアップを復元しますか？\n現在の学習記録は置き換えられます。\n回答履歴: ${data.answers.length}件`)) return;
    if (db) { await clearStore('progress'); await clearStore('sessions'); await clearStore('answers'); for (const x of data.progress) await putOne('progress',x); for (const x of data.sessions) await putOne('sessions',x); for (const x of data.answers) await putOne('answers',x); }
    else { fallback.set('progress',data.progress); fallback.set('sessions',data.sessions); fallback.set('answers',data.answers); }
    toast('バックアップを復元しました。'); renderHome();
  } catch(e) { toast(e.message || '復元に失敗しました。'); }
}
async function resetData() {
  if (!confirm('学習記録をすべて削除します。この操作は元に戻せません。続けますか？')) return;
  if (db) { await clearStore('progress'); await clearStore('sessions'); await clearStore('answers'); }
  else { fallback.set('progress',[]); fallback.set('sessions',[]); fallback.set('answers',[]); }
  toast('学習記録を削除しました。'); renderHome();
}

document.addEventListener('click', async event => {
  const modeButton=event.target.closest('[data-mode]'); if (modeButton) { chooseMode(modeButton.dataset.mode); return; }
  const answerButton=event.target.closest('[data-answer-id]'); if (answerButton) { await submitAnswer('',answerButton.dataset.answerId); return; }
  const speakButton=event.target.closest('[data-speak]'); if (speakButton) { speak(speakButton.dataset.speak); return; }
  const actionButton=event.target.closest('[data-action]'); if (!actionButton) return;
  const action=actionButton.dataset.action;
  if (action==='home'||action==='exit-quiz') { if(action==='exit-quiz'&&activeSession&&!confirm('この学習を終了しますか？回答済みの記録は保存されています。')) return; renderHome(); }
  else if (action==='choose-mode') { if (currentView !== 'home') { await renderHome(); } setTimeout(() => document.querySelector('.mode-grid')?.scrollIntoView({behavior:'smooth',block:'start'}), 30); }
  else if (action==='start-review') chooseMode('enja',true);
  else if (action==='speak-current' && activeSession?.currentWord) speak(activeSession.currentWord.word);
  else if (action==='next') { activeSession.index++; renderQuestion(); }
  else if (action==='retry-wrong') { const s=activeSession; if(s){const wrong=s.results.filter(r=>!r.isCorrect).map(r=>r.word); if(wrong.length){const oldMode=s.mode;activeSession={id:`s-${Date.now()}`,mode:oldMode,reviewOnly:true,startedAt:Date.now(),questions:shuffle(wrong),index:0,results:[],locked:false};renderQuestion();}} }
  else if (action==='words') renderWords();
  else if (action==='stats') renderStats();
  else if (action==='settings') renderSettings();
  else if (action==='export') exportData();
  else if (action==='import') document.getElementById('importFile')?.click();
  else if (action==='reset') resetData();
});
document.addEventListener('submit', async event => {
  if (event.target.id==='answerForm') { event.preventDefault(); const input=document.getElementById('answerInput'); if(input?.value.trim()) await submitAnswer(input.value.trim()); }
});
document.addEventListener('click', event => {
  if (event.target.id==='nextButton') { if(activeSession){activeSession.index++;renderQuestion();} }
});
document.addEventListener('change', event => {
  if (event.target.id==='importFile' && event.target.files?.[0]) importData(event.target.files[0]);
});
document.getElementById('brandHome').addEventListener('click',()=>renderHome());
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt=event; installButton.hidden=false; });
installButton.addEventListener('click',async()=>{if(!deferredInstallPrompt){toast('Chromeのメニューから「アプリをインストール」または「ホーム画面に追加」を選んでください。');return;}deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;installButton.hidden=true;});
boot();
