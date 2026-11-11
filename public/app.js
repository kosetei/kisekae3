const app = document.getElementById('app');
const themeToggle = document.getElementById('theme-toggle');
const pageNavLinks = [
  { key: 'home', href: '#/', label: 'キャラ一覧' },
  { key: 'clothes', href: '#/clothes', label: '服の一覧' },
  { key: 'editor-character', href: '#/editor/character', label: 'キャラ編集' },
  { key: 'editor-clothes', href: '#/editor/clothes', label: '服編集' },
  { key: 'upload', href: '#/upload', label: 'キャラ・服を追加' },
];
const savedCharacterLayout = localStorage.getItem('kisekae3-character-layout');
const savedDressFilter = localStorage.getItem('kisekae3-dress-filter');
// ComfyUI の状態。unknown: まだ確認できていない / ready: 応答あり（mock を含む）/ down: 応答なし
// starting: 起動待ち（オンデマンド起動 #10 用。今は設定する処理はない）
const COMFYUI_STATES = ['unknown', 'ready', 'down', 'starting'];
// 前回の ComfyUI の状態。初回描画で判定を待たずに服フィルタを決めるのに使う
const COMFYUI_STATUS_CACHE_KEY = 'kisekae3-comfyui-status';
let characterGridResizeObserver = null;
let characterGridUpdateFrame = 0;
let characterListObserver = null;
let characterMasonry = null;
let characterListView = null;
let characterScrollAnchor = null;
// トップのキャラ一覧で最初に表示する数と、無限スクロール・「さらに表示」1 回で追加する数（ランダムも同じ）
const CHARACTER_PAGE_SIZE = 30;
// キャラ一覧の読み込み件数・ランダム順・最後に開いたカードなどを再読み込み後も残す
const CHARACTER_LIST_STORAGE_KEY = 'kisekae3-character-list';
const savedCharacterList = loadCharacterListState();

const state = {
  catalog: null,
  selectedCatalogItems: { character: new Set(), clothes: new Set() },
  catalogFolders: { characters: savedCharacterList.folder, clothes: '' },
  characterSort: ['default', 'generated', 'recent'].includes(savedCharacterList.sort) ? savedCharacterList.sort : 'generated',
  characterLoadedCount: savedCharacterList.loadedCount,
  characterReturnId: savedCharacterList.lastCardId,
  characterLayout: ['masonry', 'cover', 'contain'].includes(savedCharacterLayout)
    ? savedCharacterLayout
    : savedCharacterLayout === 'legacy'
      ? (localStorage.getItem('kisekae3-character-thumbnail-fit') === 'cover' ? 'cover' : 'contain')
      : 'masonry',
  randomFolderActive: savedCharacterList.random,
  randomCharacterIds: savedCharacterList.randomIds,
  organizerFolders: { character: '', clothes: '' },
  page: 'home',
  editorSection: 'character',
  dressFolder: '',
  dressFolderAll: false,
  // auto は ComfyUI の状態で「すべて」/「生成済みだけ」を切り替える。明示的に選んだ値は auto を選び直すまで尊重する
  dressFilter: ['auto', 'all', 'generated', 'ungenerated'].includes(savedDressFilter) ? savedDressFilter : 'auto',
  comfyui: loadCachedComfyuiStatus(),
  currentCharacter: null, // char id when on character view
  selectedDress: null,    // dress id on character view
  selectedDressVariants: {},
  selectedGenerated: {},  // selected generated image URL per dress
  imageManagerOpen: false,
  imageActionBusy: false,
  generationSettings: null,
  stageImageRequest: 0,
  stageCharacter: null,
  stageDisplayedSrc: null,
  stageTransitionSrc: null,
  busy: false,
  uploading: false,
  prompt: '',
  promptBaseline: '',
  characterPrompt: '',
  characterPromptBaseline: '',
  dressPrompt: '',
  dressPromptBaseline: '',
  defaultPrompt: '',
  promptSettings: { presets: [], clothes: {}, characters: {} },
  seed: 0,
  disableLora: false,
  status: '',
  advancedOpen: false,
  routeHash: '',
};

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem('kisekae3-theme', theme);
  const isDark = theme === 'dark';
  themeToggle.textContent = isDark ? '☀️ ライトモード' : '🌙 ダークモード';
  themeToggle.setAttribute('aria-label', `${isDark ? 'ライト' : 'ダーク'}モードに切り替え`);
  themeToggle.setAttribute('aria-pressed', String(isDark));
}

applyTheme(document.documentElement.dataset.theme, false);
themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function createPresetId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `preset-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshCatalog() {
  state.catalog = await api('/api/catalog');
}

function findCharacter(id) {
  return state.catalog.characters.find((c) => c.id === id);
}

function generatedCount(char) {
  return Object.values(char.generated).filter((versions) => versions.length > 0).length;
}

function latestGeneratedAt(char) {
  return Object.values(char.generated).flat().reduce((latest, version) => {
    const createdAt = Date.parse(version.createdAt);
    return Number.isFinite(createdAt) ? Math.max(latest, createdAt) : latest;
  }, 0);
}

function shuffleCharacters(characters) {
  const shuffled = [...characters];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function loadCharacterListState() {
  const fallback = { folder: '', random: false, randomIds: [], loadedCount: CHARACTER_PAGE_SIZE, lastCardId: null, sort: null };
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHARACTER_LIST_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      folder: typeof saved.folder === 'string' || saved.folder === null ? saved.folder : fallback.folder,
      random: saved.random === true,
      randomIds: Array.isArray(saved.randomIds) ? saved.randomIds.filter((id) => typeof id === 'string') : [],
      loadedCount: Number.isSafeInteger(saved.loadedCount) && saved.loadedCount > 0 ? saved.loadedCount : fallback.loadedCount,
      lastCardId: typeof saved.lastCardId === 'string' ? saved.lastCardId : null,
      sort: typeof saved.sort === 'string' ? saved.sort : null,
    };
  } catch {
    return fallback;
  }
}

function persistCharacterListState() {
  try {
    sessionStorage.setItem(CHARACTER_LIST_STORAGE_KEY, JSON.stringify({
      folder: state.catalogFolders.characters,
      random: state.randomFolderActive,
      randomIds: state.randomFolderActive ? state.randomCharacterIds : [],
      loadedCount: state.characterLoadedCount,
      lastCardId: state.characterReturnId,
      sort: state.characterSort,
    }));
  } catch {
    // sessionStorage が使えない環境ではメモリ上の state だけで復元する
  }
}

// ---------------------------------------------------------------------------
// ComfyUI の状態（服フィルタの自動切り替えと生成ボタンの有効・無効に使う）
// ---------------------------------------------------------------------------

function loadCachedComfyuiStatus() {
  try {
    const cached = JSON.parse(localStorage.getItem(COMFYUI_STATUS_CACHE_KEY) || 'null');
    if (cached && COMFYUI_STATES.includes(cached.state) && cached.state !== 'unknown') {
      return {
        state: cached.state, mock: cached.mock === true, checked: false,
        startAvailable: cached.startAvailable === true, autoStart: cached.autoStart === true,
      };
    }
  } catch {
    // 壊れたキャッシュは無視して未確認扱いにする
  }
  return { state: 'unknown', mock: false, checked: false, startAvailable: false, autoStart: false };
}

function setComfyuiStatus(nextState, { mock = false, startAvailable = state.comfyui.startAvailable, autoStart = state.comfyui.autoStart } = {}) {
  if (!COMFYUI_STATES.includes(nextState)) return;
  const previous = state.comfyui;
  state.comfyui = { state: nextState, mock, checked: true, startAvailable, autoStart };
  if (nextState !== 'unknown') {
    try {
      localStorage.setItem(COMFYUI_STATUS_CACHE_KEY, JSON.stringify({ state: nextState, mock, startAvailable, autoStart }));
    } catch {
      // 保存できなくても今回の表示には影響しない
    }
  }
  // 判定が終わったら着せ替え画面だけ描き直す（表示が変わらないときと、生成中は描き直さない。
  // 生成中は理由の表示が一瞬古いままになるが、generate() 側でも状態を確かめる）
  const changed = previous.state !== nextState || previous.mock !== mock || !previous.checked
    || previous.startAvailable !== startAvailable || previous.autoStart !== autoStart;
  if (changed && state.catalog && state.currentCharacter && !state.busy) renderCharacterView();
}

// 状態の取得自体に失敗したとき。前回の判定を「確定」のまま使わず、「（前回の状態）」表示に戻す
function markComfyuiStatusUnconfirmed() {
  const previous = state.comfyui;
  if (!previous.checked) return;
  state.comfyui = { ...previous, checked: false };
  if (state.catalog && state.currentCharacter && !state.busy) renderCharacterView();
}

function comfyuiStatusLabel(comfyui = state.comfyui) {
  if (comfyui.state === 'ready') return comfyui.mock ? 'モック生成' : 'ComfyUI 応答あり';
  if (comfyui.state === 'down') return 'ComfyUI 応答なし';
  if (comfyui.state === 'starting') return 'ComfyUI 起動中';
  return 'ComfyUI 確認中';
}

// 生成できるかどうかと、その理由。
// available: そのまま生成できる / startable: 押すと ComfyUI を起動するか確認する / canPress: 生成ボタンを押せる
function generationAvailability(comfyui = state.comfyui) {
  if (comfyui.state === 'down' && comfyui.startAvailable && comfyui.autoStart) {
    return { available: true, startable: false, canPress: true, reason: 'ComfyUI 応答なし。生成すると先に ComfyUI を自動で起動します（数分かかることがあります）。' };
  }
  if (comfyui.state === 'down' && comfyui.startAvailable) {
    return { available: false, startable: true, canPress: true, reason: 'ComfyUI 応答なし。生成ボタンを押すと、ComfyUI を起動するか確認します。' };
  }
  if (comfyui.state === 'down') {
    return { available: false, startable: false, canPress: false, reason: 'ComfyUI 応答なしのため生成できません。PC や ComfyUI を起動してから、再読み込みか画面を移って状態を確認してください。' };
  }
  if (comfyui.state === 'starting') {
    return { available: false, startable: false, canPress: false, reason: 'ComfyUI 起動中のため生成できません。起動が終わるまでお待ちください。' };
  }
  return { available: true, startable: false, canPress: true, reason: '' };
}

const DRESS_FILTER_LABELS = { all: 'すべて', generated: '生成済みだけ', ungenerated: '未生成だけ' };

// 実際に効いている服フィルタ。auto のときは ComfyUI の状態から決める
function effectiveDressFilter() {
  if (state.dressFilter !== 'auto') return { filter: state.dressFilter, auto: false };
  const comfyui = state.comfyui;
  const filter = comfyui.state === 'down' || comfyui.state === 'starting' ? 'generated' : 'all';
  return { filter, auto: true, reason: `${comfyuiStatusLabel(comfyui)}${comfyui.checked || comfyui.state === 'unknown' ? '' : '（前回の状態）'}` };
}

function generatedVersions(char, dressId) {
  return char.generated[dressId] || [];
}

function selectedDressVariant(dressId) {
  const outfit = state.catalog.clothes.find((dress) => dress.id === dressId);
  const selectedId = state.selectedDressVariants[dressId];
  return outfit?.variants.some((variant) => variant.id === selectedId)
    ? selectedId
    : outfit?.variants[0]?.id || dressId;
}

function promptSettingsForDress(dressId) {
  return state.promptSettings.clothes[dressId] || { source: 'shared' };
}

function promptSettingsForCharacter(characterId) {
  return state.promptSettings.characters[characterId] || { source: 'shared' };
}

function combinePrompts(characterPrompt = '', dressPrompt = '') {
  const parts = [String(characterPrompt ?? '').trim(), String(dressPrompt ?? '').trim()].filter(Boolean);
  return parts.join('\n');
}

function syncCombinedPrompt() {
  state.prompt = combinePrompts(state.characterPrompt, state.dressPrompt);
}

function promptForSettings(settings, fallbackPrompt) {
  if (settings.source === 'preset') {
    return state.promptSettings.presets.find((preset) => preset.id === settings.presetId)?.prompt ?? fallbackPrompt;
  }
  if (settings.source === 'saved' && settings.savedPrompt !== undefined) return settings.savedPrompt;
  if (settings.source === 'last' && settings.lastPrompt !== undefined) return settings.lastPrompt;
  if (settings.source === 'default') return state.defaultPrompt;
  return fallbackPrompt;
}

function isPromptDirty() {
  return state.characterPrompt !== state.characterPromptBaseline
    || state.dressPrompt !== state.dressPromptBaseline;
}

async function persistPromptSettings() {
  state.promptSettings = await api('/api/prompt-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.promptSettings),
  });
}

async function savePromptForCurrentCharacter() {
  if (!state.currentCharacter) return false;
  const settings = promptSettingsForCharacter(state.currentCharacter);
  const previousSettings = { ...settings };
  const previousBaseline = state.characterPromptBaseline;
  state.promptSettings.characters[state.currentCharacter] = {
    ...settings,
    source: 'saved',
    savedPrompt: state.characterPrompt,
  };
  try {
    await persistPromptSettings();
    state.characterPromptBaseline = state.characterPrompt;
    setStatus('キャラ用プロンプトを保存しました');
    return true;
  } catch (error) {
    state.promptSettings.characters[state.currentCharacter] = previousSettings;
    state.characterPromptBaseline = previousBaseline;
    setStatus(`プロンプト保存失敗: ${error.message}`);
    return false;
  }
}

async function savePromptForCurrentDress() {
  if (!state.selectedDress) return false;
  const settings = promptSettingsForDress(state.selectedDress);
  const previousSettings = { ...settings };
  const previousBaseline = state.dressPromptBaseline;
  state.promptSettings.clothes[state.selectedDress] = {
    ...settings,
    source: 'saved',
    savedPrompt: state.dressPrompt,
  };
  try {
    await persistPromptSettings();
    state.dressPromptBaseline = state.dressPrompt;
    setStatus('服用プロンプトを保存しました');
    return true;
  } catch (error) {
    state.promptSettings.clothes[state.selectedDress] = previousSettings;
    state.dressPromptBaseline = previousBaseline;
    setStatus(`プロンプト保存失敗: ${error.message}`);
    return false;
  }
}

async function confirmPromptSaveBeforeLeaving() {
  if (!isPromptDirty()) return true;
  if (!window.confirm('未保存のプロンプトがあります。現在のキャラ用または服用の保存済みプロンプトとして保存しますか？\n「いいえ」を選ぶと保存せずに続行します。')) {
    return true;
  }
  try {
    if (state.characterPrompt !== state.characterPromptBaseline && !await savePromptForCurrentCharacter()) return false;
    if (state.dressPrompt !== state.dressPromptBaseline && !await savePromptForCurrentDress()) return false;
    return true;
  } catch (error) {
    setStatus(`プロンプト保存失敗: ${error.message}`);
    return false;
  }
}

function selectedVersion(char, dressId) {
  const versions = generatedVersions(char, dressId);
  return versions.find((version) => version.url === state.selectedGenerated[dressId]) || versions[0] || null;
}

function versionLabel(version, index) {
  const date = new Date(version.createdAt);
  const formattedDate = Number.isNaN(date.getTime()) ? '日時不明' : date.toLocaleString('ja-JP');
  return `${index === 0 ? '最新 — ' : ''}${formattedDate}`;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function sortedCharacterListItems() {
  if (state.randomFolderActive) {
    // ランダムはフォルダ選択時に全キャラを 1 回シャッフルした順をそのまま流す。
    // 消えたキャラは除き、あとから追加されたキャラは末尾にランダム順で足す
    const byId = new Map(state.catalog.characters.map((character) => [character.id, character]));
    const ordered = state.randomCharacterIds.map((id) => byId.get(id)).filter(Boolean);
    const known = new Set(ordered.map((character) => character.id));
    const added = shuffleCharacters(state.catalog.characters.filter((character) => !known.has(character.id)));
    const items = [...ordered, ...added];
    if (added.length || items.length !== state.randomCharacterIds.length) {
      state.randomCharacterIds = items.map((character) => character.id);
    }
    return items;
  }
  const characterFolders = groupedCatalogItems(state.catalog.characters, state.catalog.groups.characters);
  const items = [...(characterFolders.find(([group]) => group === state.catalogFolders.characters)?.[1] || [])];
  if (state.characterSort === 'generated') {
    items.sort((a, b) => generatedCount(b) - generatedCount(a));
  } else if (state.characterSort === 'recent') {
    items.sort((a, b) => latestGeneratedAt(b) - latestGeneratedAt(a));
  }
  return items;
}

// eager: 詳細から戻ったとき、戻り先より上のカードは先に読み込んで高さを確定させる
function characterCardHtml(c, { eager = false } = {}) {
  return `
    <a class="card character-card" href="#/char/${esc(c.id)}" data-character-id="${esc(c.id)}" aria-label="${esc(c.name)}">
      ${c.iconUrl ? `<img src="${esc(c.iconUrl)}" alt="" loading="${eager ? 'eager' : 'lazy'}" />` : '<div class="noimg">No icon</div>'}
      <div class="meta">
        <span class="count">${generatedCount(c)} / ${state.catalog.clothes.length} 生成済み</span>
      </div>
    </a>`;
}

// 並び替え・画像表示・フォルダを変えたときだけ呼ぶ。1 batch に戻して先頭から描き直す
function resetCharacterList() {
  state.characterLoadedCount = CHARACTER_PAGE_SIZE;
  state.characterReturnId = null;
  persistCharacterListState();
  renderCharacterList();
}

function teardownCharacterList() {
  characterGridResizeObserver?.disconnect();
  characterGridResizeObserver = null;
  characterListObserver?.disconnect();
  characterListObserver = null;
  cancelAnimationFrame(characterGridUpdateFrame);
  characterGridUpdateFrame = 0;
  characterMasonry = null;
  characterListView = null;
  stopCharacterScrollAnchor();
}

// Pinterest風レイアウト。追記時は追加したカードだけ測り、グリッド幅が変わったときだけ全カードを測り直す
function setupCharacterMasonry(grid) {
  const pending = new Set();
  const updateMasonry = () => {
    characterGridUpdateFrame = 0;
    if (!grid.isConnected) return;
    const { gridAutoRows, rowGap } = getComputedStyle(grid);
    const rowHeight = parseFloat(gridAutoRows);
    const gap = parseFloat(rowGap);
    if (!Number.isFinite(rowHeight) || rowHeight <= 0 || !Number.isFinite(gap)) return;
    const cards = [...pending];
    pending.clear();
    const spans = cards.map((card) => {
      const image = card.querySelector('img');
      const imageHeight = image
        ? image.naturalWidth && image.naturalHeight
          ? image.getBoundingClientRect().width * image.naturalHeight / image.naturalWidth
          : image.complete
            ? image.getBoundingClientRect().height
            // 読み込み前は仮に縦長 3:4 として場所を取り、読み込み後に測り直す
            : image.getBoundingClientRect().width * 4 / 3
        : card.querySelector('.noimg')?.getBoundingClientRect().height || 0;
      const metaHeight = card.querySelector('.meta')?.getBoundingClientRect().height || 0;
      const styles = getComputedStyle(card);
      const borders = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
      return Math.max(1, Math.ceil((imageHeight + metaHeight + borders + gap) / (rowHeight + gap)));
    });
    cards.forEach((card, index) => {
      card.style.gridRowEnd = `span ${spans[index]}`;
    });
    keepCharacterScrollAnchor();
  };
  const schedule = () => {
    if (!characterGridUpdateFrame) characterGridUpdateFrame = requestAnimationFrame(updateMasonry);
  };
  const addCards = (cards) => {
    cards.forEach((card) => {
      pending.add(card);
      const image = card.querySelector('img');
      if (!image) return;
      // 読み込みに失敗した画像も仮の 3:4 のまま残さず測り直す
      const remeasure = () => {
        image.removeEventListener('load', remeasure);
        image.removeEventListener('error', remeasure);
        pending.add(card);
        schedule();
      };
      image.addEventListener('load', remeasure);
      image.addEventListener('error', remeasure);
    });
    schedule();
  };
  let previousGridWidth = null;
  characterGridResizeObserver = new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    if (previousGridWidth === null || Math.abs(width - previousGridWidth) >= 1) {
      const isFirst = previousGridWidth === null;
      previousGridWidth = width;
      if (!isFirst) grid.querySelectorAll('.character-card').forEach((card) => pending.add(card));
      schedule();
    }
  });
  characterGridResizeObserver.observe(grid);
  return { addCards };
}

// 詳細から戻ったとき、画像の読み込みでレイアウトがずれても少しの間だけカード位置を保つ
function keepCharacterScrollAnchor() {
  const anchor = characterScrollAnchor;
  if (!anchor) return;
  if (performance.now() > anchor.until) {
    stopCharacterScrollAnchor();
    return;
  }
  anchor.card.isConnected && anchor.card.scrollIntoView({ block: 'center' });
}

const CHARACTER_ANCHOR_STOP_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

// 今のアンカーを外し、ユーザー操作の監視もやめる（古いアンカーのリスナーが新しいアンカーを消さないように）
function stopCharacterScrollAnchor() {
  const anchor = characterScrollAnchor;
  if (!anchor) return;
  characterScrollAnchor = null;
  CHARACTER_ANCHOR_STOP_EVENTS.forEach((type) => window.removeEventListener(type, anchor.stop, true));
}

function startCharacterScrollAnchor(card) {
  stopCharacterScrollAnchor();
  const anchor = { card, until: performance.now() + 2000 };
  anchor.stop = () => {
    if (characterScrollAnchor === anchor) stopCharacterScrollAnchor();
  };
  characterScrollAnchor = anchor;
  CHARACTER_ANCHOR_STOP_EVENTS.forEach((type) => window.addEventListener(type, anchor.stop, true));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (card.isConnected) card.scrollIntoView({ block: 'center' });
  }));
}

function updateCharacterLoadMore({ announce = false } = {}) {
  const view = characterListView;
  if (!view) return;
  const loaded = Math.min(state.characterLoadedCount, view.items.length);
  const done = loaded >= view.items.length;
  view.loadMore.hidden = done;
  view.button.textContent = `さらに表示（${loaded} / ${view.items.length}）`;
  // スクリーンリーダー向けに、追記したときだけ件数を読み上げさせる
  if (announce) {
    view.status.textContent = done
      ? `全件読み込みました（${view.items.length}件）`
      : `${loaded}件まで読み込みました（全${view.items.length}件）`;
  }
}

// 一番下に来たら次の 1 batch を追記する（全体は描き直さない）
function loadMoreCharacters({ focus = false } = {}) {
  const view = characterListView;
  if (!view || !view.grid.isConnected) return;
  const start = Math.min(state.characterLoadedCount, view.items.length);
  const next = view.items.slice(start, start + CHARACTER_PAGE_SIZE);
  if (!next.length) return;
  view.grid.insertAdjacentHTML('beforeend', next.map((c) => characterCardHtml(c)).join(''));
  state.characterLoadedCount = start + next.length;
  const newCards = [...view.grid.querySelectorAll('.character-card')].slice(start);
  characterMasonry?.addCards(newCards);
  updateCharacterLoadMore({ announce: true });
  persistCharacterListState();
  if (focus) newCards[0]?.focus();
  // 追記したカードのレイアウトが済んでから、sentinel がまだ見えているかもう一度判定させる
  observeCharacterSentinel();
}

function observeCharacterSentinel() {
  const view = characterListView;
  const observer = characterListObserver;
  if (!view || !observer) return;
  observer.unobserve(view.sentinel);
  // Pinterest風の高さ計算（requestAnimationFrame）が終わってから監視を始める
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (characterListObserver === observer && view.sentinel.isConnected && !view.loadMore.hidden) {
      observer.observe(view.sentinel);
    }
  }));
}

function renderCharacterList() {
  teardownCharacterList();
  app.className = 'home-page';
  const characterFolders = groupedCatalogItems(state.catalog.characters, state.catalog.groups.characters);
  const showList = state.randomFolderActive || state.catalogFolders.characters !== null;
  const items = showList ? sortedCharacterListItems() : [];
  const returnIndex = state.characterReturnId ? items.findIndex((c) => c.id === state.characterReturnId) : -1;
  if (returnIndex >= 0) {
    // 戻り先のカードが含まれるまで batch を展開する
    state.characterLoadedCount = Math.max(state.characterLoadedCount, Math.ceil((returnIndex + 1) / CHARACTER_PAGE_SIZE) * CHARACTER_PAGE_SIZE);
  }
  state.characterLoadedCount = Math.max(CHARACTER_PAGE_SIZE, state.characterLoadedCount || 0);
  const cards = items.slice(0, state.characterLoadedCount)
    .map((c, index) => characterCardHtml(c, { eager: index < returnIndex }))
    .join('');
  const characterListControls = showList && items.length
    ? `<div class="character-list-toolbar">
        <label for="character-layout">画像表示</label>
        <select id="character-layout">
          <option value="masonry" ${state.characterLayout === 'masonry' ? 'selected' : ''}>Pinterest風</option>
          <option value="cover" ${state.characterLayout === 'cover' ? 'selected' : ''}>余白なし（トリミング）</option>
          <option value="contain" ${state.characterLayout === 'contain' ? 'selected' : ''}>全体表示（余白あり）</option>
        </select>
        ${state.randomFolderActive ? '' : `<label for="character-sort">並び替え</label>
        <select id="character-sort">
          <option value="default" ${state.characterSort === 'default' ? 'selected' : ''}>登録順</option>
          <option value="generated" ${state.characterSort === 'generated' ? 'selected' : ''}>生成数が多い順</option>
          <option value="recent" ${state.characterSort === 'recent' ? 'selected' : ''}>最近生成した順</option>
        </select>`}
        <span class="character-list-count">${items.length}キャラ</span>
      </div>`
    : '';
  const loadMore = `<div class="character-load-more">
      <div class="character-load-sentinel" aria-hidden="true"></div>
      <button type="button" id="character-load-more"></button>
    </div>
    <p class="character-load-status visually-hidden" role="status" aria-live="polite"></p>`;
  app.innerHTML = `
    ${renderPageNav('home')}
    <h2>キャラを選ぶ</h2>
    ${state.catalog.characters.length ? `
      ${renderFolderPicker(characterFolders, state.catalogFolders.characters, 'characters', 'characters', { random: true, randomActive: state.randomFolderActive })}
      ${!showList
        ? '<p class="empty">フォルダを選ぶと中身が表示されます。</p>'
        : items.length ? `${characterListControls}<div class="character-grid ${state.characterLayout === 'masonry' ? '' : `is-${state.characterLayout}`}">${cards}</div>${loadMore}` : '<p class="empty">このフォルダにキャラはいません。</p>'}`
      : `<p class="empty">store/characters/ に chara1.png のような画像を追加するか、<a href="#/upload">キャラ・服を追加</a>から登録してください。</p>`}`;

  const grid = app.querySelector('.character-grid');
  if (grid) {
    characterListView = {
      items,
      grid,
      loadMore: app.querySelector('.character-load-more'),
      sentinel: app.querySelector('.character-load-sentinel'),
      button: app.querySelector('#character-load-more'),
      status: app.querySelector('.character-load-status'),
    };
    if (!grid.matches('.is-cover, .is-contain')) {
      characterMasonry = setupCharacterMasonry(grid);
      characterMasonry.addCards([...grid.querySelectorAll('.character-card')]);
    }
    updateCharacterLoadMore();
    characterListView.button.addEventListener('click', () => loadMoreCharacters({ focus: true }));
    if ('IntersectionObserver' in window) {
      characterListObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreCharacters();
      }, { rootMargin: '0px 0px 600px 0px' });
      observeCharacterSentinel();
    }
    grid.addEventListener('click', (event) => {
      const card = event.target.closest('.character-card');
      if (!card) return;
      state.characterReturnId = card.dataset.characterId;
      persistCharacterListState();
    });
    if (returnIndex >= 0) {
      const card = [...grid.querySelectorAll('.character-card')][returnIndex];
      if (card) startCharacterScrollAnchor(card);
    }
  }
  if (state.characterReturnId) {
    state.characterReturnId = null;
  }
  persistCharacterListState();

  app.querySelector('#character-sort')?.addEventListener('change', (event) => {
    state.characterSort = event.currentTarget.value;
    resetCharacterList();
  });
  app.querySelector('#character-layout')?.addEventListener('change', (event) => {
    state.characterLayout = event.currentTarget.value;
    localStorage.setItem('kisekae3-character-layout', state.characterLayout);
    resetCharacterList();
  });
  app.querySelectorAll('.catalog-folder').forEach((button) => {
    button.addEventListener('click', selectCatalogFolder);
  });
}

function renderUploadPage() {
  app.className = 'catalog-page upload-page';
  app.innerHTML = `
    ${renderPageNav('upload')}
    <h2>キャラ・服を追加</h2>
    <section class="upload-section">
      <div class="upload-grid">
        ${['character', 'clothes'].map((type) => `
          <form class="upload-form" data-type="${type}">
            <h3>${type === 'character' ? 'キャラ画像' : '服画像'}</h3>
            <label for="${type}-image">画像</label>
            <input id="${type}-image" name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif" multiple required />
            <p class="hint">複数選択できます。IDは自動で割り当て、ファイル名は表示名になります。PNG / JPEG / WebP / GIF / HEIC / HEIF、1枚8 MB以下</p>
            <button type="submit">追加</button>
            <span class="upload-status" role="status"></span>
          </form>`).join('')}
      </div>
    </section>`;

  app.querySelectorAll('.upload-form').forEach((form) => {
    const fileInput = form.querySelector('[name="image"]');
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      form.querySelector('.upload-status').textContent = files.length > 1
        ? `${files.length}枚選択中。IDは自動で割り当てます。`
        : '';
    });
    form.addEventListener('submit', uploadImage);
  });
}

function renderPageNav(active) {
  return `
    <nav class="page-nav" aria-label="ページの切り替え">
      ${pageNavLinks.map((page) => `
        <a href="${page.href}"${page.key === active ? ' aria-current="page"' : ''}>${page.label}</a>`).join('')}
    </nav>`;
}

function renderClothesPage() {
  app.className = 'catalog-page clothes-page';
  const clothesFolders = groupedCatalogItems(state.catalog.clothes, state.catalog.groups.clothes);
  const visibleClothes = clothesFolders.find(([group]) => group === state.catalogFolders.clothes)?.[1] || [];
  const cards = visibleClothes.map((d) => `
    <div class="card small"><img src="${d.url}" alt="${esc(d.name)}" loading="lazy" /><div class="meta"><strong>${esc(d.name)}</strong></div></div>`).join('');
  app.innerHTML = `
    ${renderPageNav('clothes')}
    <h2>登録済みの服を一覧表示</h2>
    ${state.catalog.clothes.length ? `
      ${renderFolderPicker(clothesFolders, state.catalogFolders.clothes, 'clothes')}
      ${state.catalogFolders.clothes === null
        ? '<p class="empty">フォルダを選ぶと中身が表示されます。</p>'
        : `<div class="grid small">${cards || '<p class="empty">このフォルダに服はありません。</p>'}</div>`}`
      : '<p class="empty">store/clothes/ に服の画像を追加してください。</p>'}`;

  app.querySelectorAll('.catalog-folder').forEach((button) => {
    button.addEventListener('click', selectCatalogFolder);
  });
}

function renderCatalogEditorPage(type) {
  const editorType = type === 'clothes' ? 'clothes' : 'character';
  const typeName = editorType === 'character' ? 'キャラ' : '服';
  const items = editorType === 'character' ? state.catalog.characters : state.catalog.clothingImages;
  app.className = `catalog-page editor-page editor-page-${editorType}`;
  app.innerHTML = `
    ${renderPageNav(`editor-${editorType}`)}
    <h2>${typeName}の表示名・フォルダを編集</h2>
    <p class="hint">画像またはチェックで複数選択できます。名前は画像を右クリックするか「名前」から編集できます。選択項目のつまみ（⠿）をフォルダへドラッグするとまとめて移動します。${editorType === 'clothes' ? 'チェックした複数枚は同じ服のバリエーションとしてまとめられます。' : ''}</p>
    ${renderCatalogOrganizer(editorType, items, state.catalog.groups[editorType === 'character' ? 'characters' : 'clothes'])}`;

  wireCatalogOrganizer();
}

function wireCatalogOrganizer() {
  app.querySelectorAll('.catalog-edit-form').forEach((form) => {
    form.addEventListener('contextmenu', renameCatalogItem);
  });
  app.querySelectorAll('[data-rename-catalog-item]').forEach((button) => {
    button.addEventListener('click', renameCatalogItem);
  });
  app.querySelectorAll('.catalog-item-select').forEach((checkbox) => {
    checkbox.addEventListener('change', updateCatalogSelection);
  });
  app.querySelectorAll('[data-clothing-variants]').forEach((button) => {
    button.addEventListener('click', saveCatalogVariants);
  });
  app.querySelectorAll('.catalog-thumbnail-select').forEach((button) => {
    button.addEventListener('click', () => {
      const checkbox = button.closest('.catalog-edit-form').querySelector('.catalog-item-select');
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  app.querySelectorAll('.catalog-group-form').forEach((form) => {
    form.addEventListener('submit', createCatalogGroup);
  });
  app.querySelectorAll('.catalog-rename-group').forEach((form) => {
    form.addEventListener('submit', renameCatalogGroup);
  });
  app.querySelectorAll('.catalog-drag-handle').forEach((handle) => {
    handle.addEventListener('dragstart', startCatalogDrag);
    handle.addEventListener('dragend', endCatalogDrag);
  });
  app.querySelectorAll('.catalog-folder[data-folder-view="organizer"]').forEach((lane) => {
    lane.addEventListener('dragover', (event) => {
      event.preventDefault();
      lane.classList.add('drop-target');
    });
    lane.addEventListener('dragleave', (event) => {
      if (!lane.contains(event.relatedTarget)) lane.classList.remove('drop-target');
    });
    lane.addEventListener('drop', dropCatalogItem);
  });
  app.querySelectorAll('.catalog-delete-group').forEach((button) => {
    button.addEventListener('click', deleteCatalogGroup);
  });
  app.querySelectorAll('.catalog-folder').forEach((button) => {
    button.addEventListener('click', selectCatalogFolder);
  });
}

function renderFolderPicker(folders, activeGroup, view, type = view, options = {}) {
  const { random = false, randomActive = false, all = false, allActive = false } = options;
  const allCount = folders.reduce((count, [, items]) => count + items.length, 0);
  return `
    <nav class="catalog-folder-picker" aria-label="フォルダ">
      ${folders.map(([group, items]) => `
        <button type="button" class="catalog-folder ${!randomActive && !allActive && activeGroup === group ? 'active' : ''}"
          data-folder-view="${view}" data-type="${type}" data-group="${esc(group)}"
          title="${esc(group || '未分類')} (${items.length})"
          aria-label="${esc(group || '未分類')}、${items.length}件"
          aria-pressed="${!randomActive && !allActive && activeGroup === group}">
          <span class="catalog-folder-icon" aria-hidden="true">📁</span>
          <span class="catalog-folder-label">${esc(group || '未分類')}</span>
        </button>`).join('')}
      ${all ? `
        <button type="button" class="catalog-folder ${allActive ? 'active' : ''}"
          data-folder-view="${view}" data-type="${type}" data-all-folders="true"
          title="全フォルダ横断 (${allCount})"
          aria-label="全フォルダ、${allCount}件"
          aria-pressed="${allActive}">
          <span class="catalog-folder-icon" aria-hidden="true">🗂</span>
          <span class="catalog-folder-label">全フォルダ</span>
        </button>` : ''}
      ${random ? `
        <button type="button" class="catalog-folder ${randomActive ? 'active' : ''}"
          data-folder-view="${view}" data-type="${type}" data-random-folder="true"
          title="全キャラからランダムに表示"
          aria-label="ランダム、全キャラからランダムに表示"
          aria-pressed="${randomActive}">
          <span class="catalog-folder-icon" aria-hidden="true">🎲</span>
          <span class="catalog-folder-label">ランダム</span>
        </button>` : ''}
    </nav>`;
}

function selectCatalogFolder(event) {
  const { folderView, type, group, randomFolder, allFolders } = event.currentTarget.dataset;
  if (folderView === 'organizer') {
    state.organizerFolders[type] = group;
    state.selectedCatalogItems[type].clear();
    renderCatalogEditorPage(type);
    return;
  }
  if (folderView === 'characters' || folderView === 'clothes') {
    if (folderView === 'characters' && randomFolder === 'true') {
      state.randomFolderActive = true;
      state.randomCharacterIds = shuffleCharacters(state.catalog.characters).map((character) => character.id);
      resetCharacterList();
      return;
    }
    state.catalogFolders[folderView] = group;
    if (folderView === 'characters') {
      state.randomFolderActive = false;
      state.randomCharacterIds = [];
      resetCharacterList();
      return;
    }
    renderClothesPage();
    return;
  }
  if (folderView === 'dress') {
    state.dressFolderAll = allFolders === 'true';
    if (!state.dressFolderAll) state.dressFolder = group;
    renderCharacterView();
  }
}

function renderCatalogOrganizer(type, items, declaredGroups) {
  const typeName = type === 'character' ? 'キャラ' : '服';
  const groupedItems = groupedCatalogItems(items, declaredGroups);
  const activeGroup = state.organizerFolders[type];
  const activeItems = groupedItems.find(([group]) => group === activeGroup)?.[1] || [];
  return `
    <section class="catalog-organizer" data-type="${type}">
      <h3>${typeName}の編集 (${items.length}件)</h3>
      <form class="catalog-group-form" data-type="${type}">
        <label>新しいフォルダ<input name="group" type="text" maxlength="100" required placeholder="例: 夏服" /></label>
        <button type="submit">フォルダを作成</button>
        <span class="upload-status" role="status"></span>
      </form>
      <div class="catalog-selection-actions">
        <p class="catalog-selection-status" data-type="${type}" role="status">チェックで複数選択し、選択項目のつまみをドラッグするとまとめて移動できます。</p>
        ${type === 'clothes' ? `<button type="button" data-clothing-variants="group" ${state.selectedCatalogItems.clothes.size < 2 ? 'disabled' : ''}>選択した服をバリエーションとしてまとめる</button>
          <button type="button" data-clothing-variants="ungroup" ${state.selectedCatalogItems.clothes.size < 1 ? 'disabled' : ''}>選択した服のバリエーションを解除</button>` : ''}
      </div>
      ${renderFolderPicker(groupedItems, activeGroup, 'organizer', type)}
      ${activeGroup === null
        ? '<p class="empty">フォルダをクリックすると中身を表示します。選択した項目は上のフォルダアイコンへドラッグして移動できます。</p>'
        : `<section class="catalog-folder-content">
            ${activeGroup
              ? `<form class="catalog-rename-group" data-type="${type}" data-group="${esc(activeGroup)}">
                  <input name="newGroup" type="text" maxlength="100" required value="${esc(activeGroup)}" aria-label="フォルダ名" />
                  <button type="submit">名前を変更</button>
                  <button type="button" class="catalog-delete-group" data-type="${type}" data-group="${esc(activeGroup)}">フォルダを削除</button>
                  <span class="upload-status" role="status"></span>
                </form>`
              : '<h4>未分類</h4>'}
            <p class="catalog-group-status upload-status" role="status"></p>
            <div class="catalog-group-items">
              ${activeItems.length ? activeItems.map((item) => `
                <form class="catalog-edit-form ${state.selectedCatalogItems[type].has(item.id) ? 'selected' : ''}" data-type="${type}" data-id="${esc(item.id)}">
                  <input class="catalog-item-select" type="checkbox" aria-label="${esc(item.name)}を選択"
                    ${state.selectedCatalogItems[type].has(item.id) ? 'checked' : ''} />
                  <button class="catalog-drag-handle" type="button" draggable="true" aria-label="${esc(item.name)}をドラッグして移動">⠿</button>
                  <button class="catalog-thumbnail-select" type="button"
                    aria-label="${esc(item.name)}を選択" aria-pressed="${state.selectedCatalogItems[type].has(item.id)}">
                    <img class="catalog-edit-thumbnail" src="${item.iconUrl || item.url}" alt="" loading="lazy" />
                  </button>
                  <div class="catalog-item-details">
                    <span class="catalog-id">${typeName} · ${esc(item.id)}${type === 'clothes' && item.variantOf ? ' · バリエーション' : ''}</span>
                    <strong class="catalog-item-name">${esc(item.name)}</strong>
                    <button type="button" data-rename-catalog-item>名前</button>
                    <span class="upload-status" role="status"></span>
                  </div>
                </form>`).join('') : '<p class="empty">このフォルダは空です。</p>'}
            </div>
          </section>`}
    </section>`;
}

function groupedCatalogItems(items, declaredGroups) {
  const groups = new Map();
  if (declaredGroups) groups.set('', []);
  for (const group of declaredGroups || []) groups.set(group, []);
  for (const item of items) {
    const group = item.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (!a) return b ? -1 : 0;
    if (!b) return 1;
    return a.localeCompare(b, 'ja', { numeric: true });
  });
}

function startCatalogDrag(event) {
  const form = event.currentTarget.closest('.catalog-edit-form');
  const selectedIds = state.selectedCatalogItems[form.dataset.type];
  const ids = selectedIds.has(form.dataset.id) ? [...selectedIds] : [form.dataset.id];
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', JSON.stringify({
    type: form.dataset.type,
    ids,
  }));
  for (const id of ids) {
    app.querySelector(`.catalog-edit-form[data-type="${form.dataset.type}"][data-id="${CSS.escape(id)}"]`)
      ?.classList.add('dragging');
  }
}

function endCatalogDrag(event) {
  app.querySelectorAll('.catalog-edit-form.dragging').forEach((form) => form.classList.remove('dragging'));
  app.querySelectorAll('.catalog-folder.drop-target').forEach((folder) => folder.classList.remove('drop-target'));
}

async function dropCatalogItem(event) {
  event.preventDefault();
  const folder = event.currentTarget;
  folder.classList.remove('drop-target');
  let dragged;
  try {
    dragged = JSON.parse(event.dataTransfer.getData('text/plain'));
  } catch {
    return;
  }
  if (dragged.type !== folder.dataset.type || !Array.isArray(dragged.ids) || !dragged.ids.length) return;

  const forms = dragged.ids.map((id) => app.querySelector(
    `.catalog-edit-form[data-type="${dragged.type}"][data-id="${CSS.escape(id)}"]`,
  ));
  if (forms.some((form) => !form)) return;
  const items = forms.map((form) => ({
    id: form.dataset.id,
    alias: form.querySelector('.catalog-item-name').textContent,
  }));

  try {
    const result = await api('/api/catalog-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: dragged.type,
        items,
        group: folder.dataset.group,
      }),
    });
    state.organizerFolders[dragged.type] = folder.dataset.group;
    await refreshCatalog();
    state.selectedCatalogItems[dragged.type].clear();
    renderCurrentView();
    const status = app.querySelector(`.catalog-organizer[data-type="${dragged.type}"] .catalog-group-status`);
    if (status) status.textContent = `${result.movedItems}件を「${folder.dataset.group || '未分類'}」へ移動しました`;
  } catch (error) {
    forms[0].querySelector('.upload-status').textContent = `移動失敗: ${error.message}`;
  }
}

function updateCatalogSelection(event) {
  const checkbox = event.currentTarget;
  const form = checkbox.closest('.catalog-edit-form');
  const { type, id } = form.dataset;
  const selected = state.selectedCatalogItems[type];
  if (checkbox.checked) selected.add(id);
  else selected.delete(id);
  form.classList.toggle('selected', checkbox.checked);
  form.querySelector('.catalog-thumbnail-select').setAttribute('aria-pressed', String(checkbox.checked));
  const status = app.querySelector(`.catalog-selection-status[data-type="${type}"]`);
  if (status) {
    status.textContent = selected.size
      ? `${selected.size}件を選択中。選択項目のつまみをドラッグして移動できます。`
      : 'チェックで複数選択し、選択項目のつまみをドラッグするとまとめて移動できます。';
  }
  app.querySelectorAll('[data-clothing-variants]').forEach((button) => {
    const clothingSelectionCount = state.selectedCatalogItems.clothes.size;
    button.disabled = button.dataset.clothingVariants === 'group' ? clothingSelectionCount < 2 : clothingSelectionCount < 1;
  });
}

async function saveCatalogVariants(event) {
  const button = event.currentTarget;
  const ids = [...state.selectedCatalogItems.clothes];
  if (button.dataset.clothingVariants === 'group' && ids.length < 2) return;
  if (!ids.length) return;
  const outfitId = button.dataset.clothingVariants === 'ungroup' ? null : ids[0];
  button.disabled = true;
  const status = app.querySelector('.catalog-organizer[data-type="clothes"] .catalog-group-status');
  if (status) status.textContent = outfitId ? 'バリエーションをまとめています…' : 'バリエーションを解除しています…';
  try {
    const result = await api('/api/clothing-variants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, outfitId }),
    });
    state.selectedCatalogItems.clothes.clear();
    await refreshCatalog();
    renderCurrentView();
    const resultStatus = app.querySelector('.catalog-organizer[data-type="clothes"] .catalog-group-status');
    if (resultStatus) {
      resultStatus.textContent = outfitId
        ? `${result.ids.length}枚を同じ服のバリエーションとしてまとめました`
        : `${result.ids.length}枚のバリエーションを解除しました`;
    }
  } catch (error) {
    if (status) status.textContent = `バリエーション設定失敗: ${error.message}`;
    if (button.isConnected) button.disabled = false;
  }
}

function renderCharacterView() {
  app.className = 'character-page';
  const char = findCharacter(state.currentCharacter);
  if (!char) { app.innerHTML = '<p class="error">キャラが見つかりません。</p>'; return; }
  const existingLayout = state.stageCharacter === char.id
    ? app.querySelector('.character-layout')
    : null;
  const dressScrollLeft = app.dataset.character === char.id
    ? app.querySelector('.dress-grid')?.scrollLeft || 0
    : 0;
  app.dataset.character = char.id;

  const sel = state.selectedDress;
  const selectedOutfit = state.catalog.clothes.find((dress) => dress.id === sel);
  const selectedDressName = selectedOutfit?.name || sel;
  const selectedVariantId = selectedDressVariant(sel);
  const versions = sel ? generatedVersions(char, sel) : [];
  const selected = sel ? selectedVersion(char, sel) : null;
  const selUrl = selected?.url || null;
  const displaySrc = selUrl || char.iconUrl;
  if (state.stageCharacter !== char.id) {
    state.stageImageRequest += 1;
    state.stageCharacter = char.id;
    state.stageDisplayedSrc = char.iconUrl;
    state.stageTransitionSrc = null;
  }
  const missing = state.catalog.clothes.filter((d) => !generatedVersions(char, d.id).length);
  const dressFolders = groupedCatalogItems(state.catalog.clothes, state.catalog.groups.clothes);
  // 全フォルダモードはフォルダをまたぎ、フォルダ順のまま全服を並べる
  const scopedDresses = state.dressFolderAll
    ? dressFolders.flatMap(([, items]) => items)
    : dressFolders.find(([group]) => group === state.dressFolder)?.[1] || [];
  const dressFilter = effectiveDressFilter();
  const generation = generationAvailability();
  const dressMatchesFilter = (dress) => {
    const done = generatedVersions(char, dress.id).length > 0;
    if (dressFilter.filter === 'generated') return done;
    if (dressFilter.filter === 'ungenerated') return !done;
    return true;
  };
  // 選択中の服は条件に当てはまらない場合でも一覧に残し、現在の表示とのズレを防ぐ
  const visibleDresses = scopedDresses.filter((dress) => dress.id === sel || dressMatchesFilter(dress));
  const scopedGeneratedCount = scopedDresses.filter((dress) => generatedVersions(char, dress.id).length).length;
  const selectedOutsideFilter = sel
    && scopedDresses.some((dress) => dress.id === sel)
    && !dressMatchesFilter(scopedDresses.find((dress) => dress.id === sel));
  const generatedTotal = versions.length;
  const scopeLabel = state.dressFolderAll ? '全フォルダ' : 'フォルダ内';
  const dressGridHtml = visibleDresses.length
    ? `<div class="dress-grid">${visibleDresses.map((d) => {
        const done = generatedVersions(char, d.id).length > 0;
        const groupTag = state.dressFolderAll ? `<span class="dress-group-tag">${esc(d.group || '未分類')}</span>` : '';
        return `
        <button class="card small dress ${d.id === sel ? 'selected' : ''}" data-dress="${esc(d.id)}" aria-label="${esc(d.name)}">
          <img src="${d.url}" alt="" loading="lazy" />
          <div class="meta">
            ${groupTag}
            <span class="badge ${done ? 'done' : 'todo'}">${done ? '生成済み' : '未生成'}</span>
          </div>
        </button>`;
      }).join('')}</div>`
    : `<p class="empty">${state.dressFolderAll ? '全フォルダに' : 'このフォルダに'}表示条件に合う服はありません。</p>`;
  const stageSrc = state.stageDisplayedSrc || displaySrc;
  const dressPromptSettings = sel ? promptSettingsForDress(sel) : { source: 'shared' };
  const characterPromptSettings = state.currentCharacter ? promptSettingsForCharacter(state.currentCharacter) : { source: 'shared' };
  const characterPreset = state.promptSettings.presets.find((preset) => (
    characterPromptSettings.source === 'preset'
      && preset.id === characterPromptSettings.presetId
      && preset.scope === 'character'
  ));
  const dressPreset = state.promptSettings.presets.find((preset) => (
    dressPromptSettings.source === 'preset'
      && preset.id === dressPromptSettings.presetId
      && preset.scope === 'dress'
  ));

  const view = `
    <div class="character-toolbar">
      <a href="#/">← キャラ一覧</a>
      <h2>${esc(char.name)}</h2>
    </div>

    <div class="character-layout">
      <section class="stage">
        <div id="stage" class="stage-image ${state.busy ? 'busy' : ''}">
          ${stageSrc ? `<img src="${stageSrc}" alt="${esc(char.name)}${sel ? ` — ${esc(selectedDressName)}` : ''}" />` : '<p class="empty">画像がありません</p>'}
          ${state.busy ? '<div class="spinner">生成中…</div>' : ''}
        </div>
      </section>

      <section class="dresses">
        <h3>服を選ぶ</h3>
        <div class="dress-filter-bar">
          <label for="dress-filter">表示する服</label>
          <select id="dress-filter">
            <option value="auto" ${state.dressFilter === 'auto' ? 'selected' : ''}>自動（ComfyUI の状態で切り替え）</option>
            <option value="all" ${state.dressFilter === 'all' ? 'selected' : ''}>すべて</option>
            <option value="generated" ${state.dressFilter === 'generated' ? 'selected' : ''}>生成済みだけ</option>
            <option value="ungenerated" ${state.dressFilter === 'ungenerated' ? 'selected' : ''}>未生成だけ</option>
          </select>
          <span class="dress-filter-count">表示 ${visibleDresses.length}件 / ${scopeLabel} ${scopedDresses.length}件（生成済み ${scopedGeneratedCount}件）</span>
        </div>
        ${dressFilter.auto ? `<p class="hint dress-filter-auto" role="status">自動: ${esc(dressFilter.reason)} → ${DRESS_FILTER_LABELS[dressFilter.filter]}（${visibleDresses.length}件）</p>` : ''}
        ${selectedOutsideFilter ? '<p class="hint dress-filter-hint">選択中の服は表示条件に当てはまらないため、この一覧では常に表示します。</p>' : ''}
        ${state.dressFolderAll ? dressGridHtml : state.dressFolder === null
          ? '<p class="empty">フォルダを選ぶと服が表示されます。</p>'
          : dressGridHtml}
        <div class="dress-folder-picker">${renderFolderPicker(dressFolders, state.dressFolder, 'dress', 'dress', { all: true, allActive: state.dressFolderAll })}</div>
        ${sel ? `<p class="stage-caption">
          選択中の服: ${selUrl ? `生成済み (${versions.length}件)` : `未生成${generation.canPress ? '' : `（${esc(comfyuiStatusLabel())}のため生成できません）`}`}
        </p>
        ${selectedOutfit?.variants.length > 1 ? `<fieldset class="dress-variant-picker">
          <legend>生成に使う画像</legend>
          <div class="dress-variant-grid">${selectedOutfit.variants.map((variant) => `
            <label class="dress-variant ${selectedVariantId === variant.id ? 'selected' : ''}">
              <input type="radio" name="dress-variant" value="${esc(variant.id)}" ${selectedVariantId === variant.id ? 'checked' : ''} />
              <img src="${variant.url}" alt="" loading="lazy" />
              <span>${esc(variant.name)}</span>
            </label>`).join('')}</div>
          <p class="hint">着せ替え上は同じ服として扱い、画像は生成・再生成時にだけ使われます。</p>
        </fieldset>` : ''}` : ''}
      </section>
    </div>

    ${sel ? `
      <details class="image-manager" ${state.imageManagerOpen ? 'open' : ''}>
        <summary>生成画像を整理 (${generatedTotal})</summary>
        <div class="image-manager-content">
          ${generatedTotal ? `<div class="generated-image-grid">
            ${versions.map((version, index) => `
              <article class="generated-image-card ${version.primary ? 'primary' : ''}">
                <img src="${version.url}" alt="${esc(selectedDressName)} ${esc(versionLabel(version, index))}" loading="lazy" />
                <div class="generated-image-meta">
                  ${version.primary ? '<span class="primary-badge">第一選択</span>' : ''}
                  <span>${esc(versionLabel(version, index))}</span>
                </div>
                <div class="generated-image-actions">
                  <button type="button" data-primary-image="${esc(version.file)}" aria-label="${version.primary ? 'サムネに設定済み' : 'この画像をサムネにする'}" ${version.primary || state.imageActionBusy ? 'disabled' : ''}>
                    サムネ
                  </button>
                  <button type="button" data-generation-settings="${esc(version.file)}">設定を見る</button>
                  <button type="button" class="danger-button" data-delete-image="${esc(version.file)}" ${state.imageActionBusy ? 'disabled' : ''}>削除</button>
                </div>
              </article>`).join('')}
          </div>` : '<p class="empty">この服の生成画像はまだありません。</p>'}
          <p id="image-manager-status" class="image-manager-status" role="status">${esc(state.status)}</p>
        </div>
      </details>` : ''}

    ${sel ? `
      <dialog id="generation-settings-dialog" class="generation-settings-dialog" aria-labelledby="generation-settings-title">
        <form method="dialog" class="generation-settings-form">
          <h3 id="generation-settings-title">生成時の設定</h3>
          <label for="generation-settings-character-prompt">キャラ調整用のプロンプト</label>
          <textarea id="generation-settings-character-prompt" rows="4" readonly></textarea>
          <label for="generation-settings-dress-prompt">服のプロンプト</label>
          <textarea id="generation-settings-dress-prompt" rows="4" readonly></textarea>
          <p>シード: <span id="generation-settings-seed">読み込み中…</span></p>
          <p>LoRA: <span id="generation-settings-lora">読み込み中…</span></p>
          <p id="generation-settings-status" class="upload-status" role="status">読み込み中…</p>
          <div class="generation-settings-actions">
            <button id="apply-generation-settings" type="button" disabled>入力欄に適用</button>
            <button type="submit">閉じる</button>
          </div>
        </form>
      </dialog>` : ''}

    <details class="advanced-settings" ${state.advancedOpen ? 'open' : ''}>
      <summary>生成設定・その他</summary>
      <div class="advanced-content">
        ${versions.length > 1 ? `
          <label for="generated-version">表示する生成画像</label>
          <select id="generated-version">
            ${versions.map((version, index) => `
              <option value="${esc(version.url)}" ${version.url === selected.url ? 'selected' : ''}>
                ${esc(versionLabel(version, index))}
              </option>`).join('')}
          </select>` : ''}
        <div class="generation-actions">
          <button id="generate-all" ${missing.length && generation.canPress ? '' : 'disabled'} ${generation.reason ? 'aria-describedby="generation-unavailable"' : ''}>未生成を一括生成 (${missing.length})</button>
          ${sel && !versions.length ? `<button id="generate-selected" ${generation.canPress ? '' : 'disabled'} ${generation.reason ? 'aria-describedby="generation-unavailable"' : ''}>この服を生成</button>` : ''}
          <button id="regenerate-selected" ${sel && versions.length && generation.canPress ? '' : 'disabled'} ${generation.reason ? 'aria-describedby="generation-unavailable"' : ''}>選択中を再生成</button>
          <span id="status" role="status">${esc(state.status)}</span>
        </div>
        ${generation.reason ? `<p id="generation-unavailable" class="hint generation-unavailable">${esc(generation.reason)}</p>` : ''}
        <section class="seed-settings">
          <label for="seed">シード</label>
          <div class="seed-controls">
            <input id="seed" type="number" min="0" max="9007199254740991" step="1" value="${esc(state.seed)}" />
            <button id="randomize-seed" type="button">ランダム</button>
          </div>
        </section>
        <section class="lora-settings">
          <span class="lora-label">LoRA</span>
          <div class="lora-controls" role="group" aria-label="LoRA設定">
            <button id="lora-use" class="lora-choice" type="button" aria-pressed="${!state.disableLora}">使う</button>
            <button id="lora-disable" class="lora-choice" type="button" aria-pressed="${state.disableLora}">使わない</button>
          </div>
        </section>
        <section class="prompt-settings">
          <label for="character-prompt">キャラ調整用のプロンプト</label>
          <textarea id="character-prompt" rows="3">${esc(state.characterPrompt)}</textarea>
          <label for="character-prompt-source">このキャラで使うプロンプト</label>
          <select id="character-prompt-source" ${state.currentCharacter ? '' : 'disabled'}>
            <option value="shared" ${characterPromptSettings.source === 'shared' ? 'selected' : ''}>共通の入力を引き継ぐ</option>
            ${characterPromptSettings.savedPrompt !== undefined ? `<option value="saved" ${characterPromptSettings.source === 'saved' ? 'selected' : ''}>このキャラに保存したプロンプト</option>` : ''}
            ${characterPromptSettings.lastPrompt !== undefined ? `<option value="last" ${characterPromptSettings.source === 'last' ? 'selected' : ''}>このキャラの最後の生成プロンプト</option>` : ''}
            ${state.promptSettings.presets.filter((preset) => preset.scope === 'character').map((preset) => `
              <option value="preset:${esc(preset.id)}" ${characterPromptSettings.source === 'preset' && characterPromptSettings.presetId === preset.id ? 'selected' : ''}>プリセット: ${esc(preset.name)}</option>`).join('')}
          </select>
          <div class="prompt-preset-actions">
            <label for="character-preset-name">キャラ用プリセット名</label>
            <input id="character-preset-name" type="text" maxlength="100" placeholder="例: キャラ調整" />
            <button id="save-character-preset" type="button">キャラ用入力をプリセットに保存</button>
            <button id="update-character-preset" type="button" ${characterPreset ? '' : 'disabled'}>選択中を更新</button>
            <button id="delete-character-preset" type="button" ${characterPreset ? '' : 'disabled'}>選択中を削除</button>
            <button id="save-character-prompt" type="button">このキャラ用プロンプトを保存</button>
          </div>

          <label for="dress-prompt">服のプロンプト</label>
          <textarea id="dress-prompt" rows="3">${esc(state.dressPrompt)}</textarea>
          <label for="prompt-source">この服で使うプロンプト</label>
          <select id="prompt-source" ${sel ? '' : 'disabled'}>
            <option value="shared" ${dressPromptSettings.source === 'shared' ? 'selected' : ''}>共通の入力を引き継ぐ</option>
            <option value="default" ${dressPromptSettings.source === 'default' ? 'selected' : ''}>デフォルトプロンプト</option>
            ${dressPromptSettings.savedPrompt !== undefined ? `<option value="saved" ${dressPromptSettings.source === 'saved' ? 'selected' : ''}>この服に保存したプロンプト</option>` : ''}
            ${dressPromptSettings.lastPrompt !== undefined ? `<option value="last" ${dressPromptSettings.source === 'last' ? 'selected' : ''}>この服の最後の生成プロンプト</option>` : ''}
            ${state.promptSettings.presets.filter((preset) => preset.scope === 'dress').map((preset) => `
              <option value="preset:${esc(preset.id)}" ${dressPromptSettings.source === 'preset' && dressPromptSettings.presetId === preset.id ? 'selected' : ''}>プリセット: ${esc(preset.name)}</option>`).join('')}
          </select>
          <div class="prompt-preset-actions">
            <label for="preset-name">プリセット名</label>
            <input id="preset-name" type="text" maxlength="100" placeholder="例: 上下セット" />
            <button id="save-prompt" type="button">この服用プロンプトを保存</button>
            <button id="save-preset" type="button">服用入力をプリセットに保存</button>
            <button id="update-preset" type="button" ${dressPreset ? '' : 'disabled'}>選択中を更新</button>
            <button id="delete-preset" type="button" ${dressPreset ? '' : 'disabled'}>選択中を削除</button>
          </div>
          <p class="hint">生成時は「キャラ調整用」と「服の」プロンプトを合成して送信します。履歴と保存もキャラごと／服ごとに分けて管理されます。</p>
        </section>
      </div>
    </details>`;

  if (!existingLayout) {
    app.innerHTML = view;
  } else {
    const nextView = document.createElement('div');
    nextView.innerHTML = view;
    const nextToolbar = nextView.querySelector('.character-toolbar');
    const nextLayout = nextView.querySelector('.character-layout');
    const nextDresses = nextLayout?.querySelector('.dresses');
    const currentDresses = existingLayout.querySelector('.dresses');
    if (!nextToolbar || !nextLayout || !nextDresses || !currentDresses) {
      throw new Error('着せ替え画面を更新できません');
    }

    app.querySelector('.character-toolbar')?.replaceWith(nextToolbar);
    currentDresses.replaceWith(nextDresses);
    for (const child of [...app.children]) {
      if (child !== nextToolbar && child !== existingLayout) child.remove();
    }
    app.insertBefore(nextToolbar, existingLayout);
    for (const child of [...nextView.children]) {
      if (child !== nextLayout) app.append(child);
    }
  }

  const stage = document.getElementById('stage');
  stage?.classList.toggle('busy', state.busy);
  const spinner = stage?.querySelector('.spinner');
  if (state.busy && stage && !spinner) {
    const newSpinner = document.createElement('div');
    newSpinner.className = 'spinner';
    newSpinner.textContent = '生成中…';
    stage.append(newSpinner);
  } else if (!state.busy) {
    spinner?.remove();
  }

  const dressGrid = app.querySelector('.dress-grid');
  if (dressGrid) dressGrid.scrollLeft = dressScrollLeft;

  if (displaySrc && displaySrc !== stageSrc) {
    transitionStageImage(displaySrc, `${char.name}${sel ? ` — ${selectedDressName}` : ''}`);
  } else if (state.stageTransitionSrc && state.stageTransitionSrc !== displaySrc) {
    state.stageImageRequest += 1;
    state.stageTransitionSrc = null;
    document.querySelectorAll('#stage img.stage-image-overlay').forEach((image) => image.remove());
  }

  const advancedSettings = app.querySelector('.advanced-settings');
  advancedSettings.addEventListener('toggle', () => {
    state.advancedOpen = advancedSettings.open;
  });
  const imageManager = app.querySelector('.image-manager');
  if (imageManager) {
    imageManager.addEventListener('toggle', () => {
      state.imageManagerOpen = imageManager.open;
    });
  }
  app.querySelectorAll('[data-primary-image]').forEach((button) => {
    button.addEventListener('click', () => setPrimaryImage(button.dataset.primaryImage));
  });
  app.querySelectorAll('[data-generation-settings]').forEach((button) => {
    button.addEventListener('click', () => showGenerationSettings(button.dataset.generationSettings));
  });
  const generationSettingsDialog = document.getElementById('generation-settings-dialog');
  if (generationSettingsDialog) {
    document.getElementById('apply-generation-settings').addEventListener('click', applyGenerationSettings);
  }
  app.querySelectorAll('[data-delete-image]').forEach((button) => {
    button.addEventListener('click', () => deleteGeneratedImage(button.dataset.deleteImage));
  });
  app.querySelectorAll('button.dress').forEach((btn) => {
    btn.addEventListener('click', () => selectDress(btn.dataset.dress));
  });
  app.querySelectorAll('input[name="dress-variant"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      state.selectedDressVariants[sel] = event.currentTarget.value;
      renderCharacterView();
    });
  });
  app.querySelector('#dress-filter')?.addEventListener('change', (event) => {
    state.dressFilter = event.currentTarget.value;
    localStorage.setItem('kisekae3-dress-filter', state.dressFilter);
    renderCharacterView();
  });
  app.querySelectorAll('.catalog-folder[data-folder-view="dress"]').forEach((button) => {
    button.addEventListener('click', selectCatalogFolder);
  });
  const versionSelect = document.getElementById('generated-version');
  if (versionSelect) {
    versionSelect.addEventListener('change', (event) => {
      state.selectedGenerated[sel] = event.target.value;
      renderCharacterView();
    });
  }
  document.getElementById('character-prompt')?.addEventListener('input', (event) => {
    state.characterPrompt = event.target.value;
    syncCombinedPrompt();
  });
  document.getElementById('dress-prompt')?.addEventListener('input', (event) => {
    state.dressPrompt = event.target.value;
    syncCombinedPrompt();
  });
  document.getElementById('character-prompt-source')?.addEventListener('change', changeCharacterPromptSource);
  document.getElementById('prompt-source').addEventListener('change', changePromptSource);
  document.getElementById('save-character-prompt').addEventListener('click', savePromptForCurrentCharacter);
  document.getElementById('save-prompt').addEventListener('click', savePromptForCurrentDress);
  document.getElementById('save-character-preset').addEventListener('click', () => savePromptPreset('character'));
  document.getElementById('save-preset').addEventListener('click', () => savePromptPreset('dress'));
  document.getElementById('update-character-preset').addEventListener('click', () => updatePromptPreset('character'));
  document.getElementById('update-preset').addEventListener('click', () => updatePromptPreset('dress'));
  document.getElementById('delete-character-preset').addEventListener('click', () => deletePromptPreset('character'));
  document.getElementById('delete-preset').addEventListener('click', () => deletePromptPreset('dress'));
  document.getElementById('seed').addEventListener('input', (event) => {
    state.seed = event.target.value;
  });
  const loraUseButton = document.getElementById('lora-use');
  const loraDisableButton = document.getElementById('lora-disable');
  const updateLoraButtons = () => {
    loraUseButton.setAttribute('aria-pressed', String(!state.disableLora));
    loraDisableButton.setAttribute('aria-pressed', String(state.disableLora));
  };
  loraUseButton.addEventListener('click', () => {
    state.disableLora = false;
    updateLoraButtons();
  });
  loraDisableButton.addEventListener('click', () => {
    state.disableLora = true;
    updateLoraButtons();
  });
  document.getElementById('randomize-seed').addEventListener('click', () => {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    state.seed = (values[0] & 0x1fffff) * 0x100000000 + values[1];
    renderCharacterView();
  });
  const allBtn = document.getElementById('generate-all');
  if (allBtn && !allBtn.disabled) allBtn.addEventListener('click', generateAll);
  const regenerateBtn = document.getElementById('regenerate-selected');
  if (regenerateBtn && !regenerateBtn.disabled) {
    regenerateBtn.addEventListener('click', () => generate(char, sel, true, null, selectedVariantId));
  }
  const generateSelectedBtn = document.getElementById('generate-selected');
  if (generateSelectedBtn) {
    generateSelectedBtn.disabled = state.busy || !generation.canPress;
    generateSelectedBtn.addEventListener('click', () => generate(char, sel, false, null, selectedVariantId));
  }
}

async function deleteCatalogGroup(event) {
  const button = event.currentTarget;
  const { type, group } = button.dataset;
  if (!window.confirm(`フォルダ「${group}」を削除しますか？中のアイテムは未分類に移動します。`)) return;

  button.disabled = true;
  try {
    await api('/api/catalog-group', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, group }),
    });
    state.organizerFolders[type] = null;
    if (type === 'character' && state.catalogFolders.characters === group) state.catalogFolders.characters = null;
    if (type === 'clothes' && state.catalogFolders.clothes === group) state.catalogFolders.clothes = null;
    if (type === 'clothes' && state.dressFolder === group) state.dressFolder = null;
    await refreshCatalog();
    renderCurrentView();
  } catch (error) {
    const organizer = button.closest('.catalog-organizer');
    const status = organizer?.querySelector('.catalog-folder-content .catalog-group-status');
    if (status) status.textContent = `削除失敗: ${error.message}`;
    else setStatus(`フォルダ削除失敗: ${error.message}`);
    if (button.isConnected) button.disabled = false;
  }
}

async function renameCatalogGroup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.upload-status');
  button.disabled = true;
  status.textContent = '変更中…';
  try {
    const result = await api('/api/catalog-group', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: form.dataset.type,
        group: form.dataset.group,
        newGroup: form.elements.newGroup.value,
      }),
    });
    const { type, group, newGroup } = result;
    state.organizerFolders[type] = newGroup;
    if (type === 'character' && state.catalogFolders.characters === group) state.catalogFolders.characters = newGroup;
    if (type === 'clothes' && state.catalogFolders.clothes === group) state.catalogFolders.clothes = newGroup;
    if (type === 'clothes' && state.dressFolder === group) state.dressFolder = newGroup;
    await refreshCatalog();
    renderCurrentView();
    const organizer = app.querySelector(`.catalog-organizer[data-type="${type}"]`);
    const renamedForm = [...(organizer?.querySelectorAll('.catalog-rename-group') || [])]
      .find((candidate) => candidate.dataset.group === newGroup);
    if (renamedForm) renamedForm.querySelector('.upload-status').textContent = 'フォルダ名を変更しました';
  } catch (error) {
    if (status.isConnected) status.textContent = `変更失敗: ${error.message}`;
    if (button.isConnected) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function transitionStageImage(src, alt) {
  if (state.stageTransitionSrc === src) return;
  const request = ++state.stageImageRequest;
  state.stageTransitionSrc = src;
  document.querySelectorAll('#stage img.stage-image-overlay').forEach((image) => image.remove());
  const preload = new Image();
  preload.onload = () => {
    if (request !== state.stageImageRequest) return;
    const stage = document.getElementById('stage');
    if (!stage) return;

    const next = document.createElement('img');
    next.src = src;
    next.alt = alt;
    next.className = 'stage-image-overlay';
    const finishTransition = () => {
      if (request !== state.stageImageRequest || state.stageTransitionSrc !== src) return;
      stage.querySelectorAll('img').forEach((image) => {
        if (image !== next) image.remove();
      });
      next.classList.remove('stage-image-overlay');
      state.stageDisplayedSrc = src;
      state.stageTransitionSrc = null;
    };
    next.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'opacity') finishTransition();
    }, { once: true });
    stage.append(next);
    requestAnimationFrame(() => {
      if (request !== state.stageImageRequest) return;
      requestAnimationFrame(() => {
        if (request === state.stageImageRequest) next.classList.add('stage-image-visible');
      });
    });
    window.setTimeout(finishTransition, 1100);
  };
  preload.onerror = () => {
    if (request === state.stageImageRequest) {
      state.stageTransitionSrc = null;
      setStatus('画像を読み込めませんでした');
    }
  };
  preload.src = src;
}

async function selectDress(dressId) {
  if (dressId === state.selectedDress) {
    const char = findCharacter(state.currentCharacter);
    if (!generatedVersions(char, dressId).length) {
      await generate(char, dressId, false, null, selectedDressVariant(dressId));
    }
    return;
  }
  if (!await confirmPromptSaveBeforeLeaving()) {
    renderCharacterView();
    return;
  }
  if (dressId !== state.selectedDress) state.imageManagerOpen = false;
  state.selectedDress = dressId;
  const settings = promptSettingsForDress(dressId);
  if (settings.source === 'preset') {
    const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
    if (preset) state.dressPrompt = preset.prompt;
  } else if (settings.source === 'saved' && settings.savedPrompt !== undefined) {
    state.dressPrompt = settings.savedPrompt;
  } else if (settings.source === 'last' && settings.lastPrompt !== undefined) {
    state.dressPrompt = settings.lastPrompt;
  } else if (settings.source === 'default') {
    state.dressPrompt = state.defaultPrompt;
  }
  syncCombinedPrompt();
  state.dressPromptBaseline = state.dressPrompt;
  const char = findCharacter(state.currentCharacter);
  if (generatedVersions(char, dressId).length) {
    renderCharacterView();
    return;
  }
  state.advancedOpen = true;
  renderCharacterView();
}

async function setPrimaryImage(file) {
  if (state.imageActionBusy) return;
  const character = state.currentCharacter;
  const dress = state.selectedDress;
  state.imageActionBusy = true;
  setStatus('第一選択を保存中…');
  renderCharacterView();
  try {
    await api('/api/generated-selection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character, dress, file }),
    });
    await refreshCatalog();
    delete state.selectedGenerated[dress];
    setStatus('第一選択を保存しました');
  } catch (error) {
    setStatus(`第一選択の保存失敗: ${error.message}`);
  } finally {
    state.imageActionBusy = false;
    renderCharacterView();
  }
}

async function showGenerationSettings(file) {
  const dialog = document.getElementById('generation-settings-dialog');
  if (!dialog) return;
  const characterPrompt = document.getElementById('generation-settings-character-prompt');
  const dressPrompt = document.getElementById('generation-settings-dress-prompt');
  const seed = document.getElementById('generation-settings-seed');
  const lora = document.getElementById('generation-settings-lora');
  const status = document.getElementById('generation-settings-status');
  const applyButton = document.getElementById('apply-generation-settings');
  state.generationSettings = null;
  characterPrompt.value = '';
  dressPrompt.value = '';
  seed.textContent = '読み込み中…';
  lora.textContent = '読み込み中…';
  status.textContent = '読み込み中…';
  applyButton.disabled = true;
  if (!dialog.open) dialog.showModal();

  const query = new URLSearchParams({
    character: state.currentCharacter,
    dress: state.selectedDress,
    file,
  });
  try {
    const settings = await api(`/api/generated-settings?${query}`);
    state.generationSettings = settings;
    characterPrompt.value = settings.characterPrompt ?? '';
    dressPrompt.value = settings.dressPrompt ?? settings.prompt ?? '';
    seed.textContent = settings.seed === null ? '記録なし' : String(settings.seed);
    lora.textContent = typeof settings.disableLora === 'boolean'
      ? settings.disableLora ? '使わない' : '使う'
      : '記録なし';
    const hasSettings = settings.prompt !== null || settings.characterPrompt !== null || settings.dressPrompt !== null || settings.seed !== null
      || typeof settings.disableLora === 'boolean';
    status.textContent = hasSettings ? '' : 'この画像の生成設定は保存されていません。';
    applyButton.disabled = !hasSettings;
  } catch (error) {
    seed.textContent = '取得できませんでした';
    lora.textContent = '取得できませんでした';
    status.textContent = `設定の取得失敗: ${error.message}`;
  }
}

function applyGenerationSettings() {
  const settings = state.generationSettings;
  if (!settings) return;
  if (typeof settings.characterPrompt === 'string' || typeof settings.dressPrompt === 'string') {
    state.characterPrompt = settings.characterPrompt ?? '';
    state.dressPrompt = settings.dressPrompt ?? '';
    state.characterPromptBaseline = state.characterPrompt;
    state.dressPromptBaseline = state.dressPrompt;
    syncCombinedPrompt();
  } else if (typeof settings.prompt === 'string') {
    state.characterPrompt = '';
    state.dressPrompt = settings.prompt;
    state.characterPromptBaseline = state.characterPrompt;
    state.dressPromptBaseline = state.dressPrompt;
    syncCombinedPrompt();
  }
  if (Number.isSafeInteger(settings.seed)) state.seed = settings.seed;
  if (typeof settings.disableLora === 'boolean') state.disableLora = settings.disableLora;
  state.advancedOpen = true;
  document.getElementById('generation-settings-dialog')?.close();
  renderCharacterView();
}

async function deleteGeneratedImage(file) {
  if (state.imageActionBusy) return;
  if (!window.confirm('この生成画像を削除します。この操作は取り消せません。よろしいですか？')) return;
  const character = state.currentCharacter;
  const dress = state.selectedDress;
  state.imageActionBusy = true;
  setStatus('画像を削除中…');
  renderCharacterView();
  try {
    await api('/api/generated-image', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character, dress, file }),
    });
    await refreshCatalog();
    delete state.selectedGenerated[dress];
    setStatus('画像を削除しました');
  } catch (error) {
    setStatus(`画像の削除失敗: ${error.message}`);
  } finally {
    state.imageActionBusy = false;
    renderCharacterView();
  }
}

async function changeCharacterPromptSource(event) {
  if (!await confirmPromptSaveBeforeLeaving()) {
    renderCharacterView();
    return;
  }
  const characterId = state.currentCharacter;
  const previousPrompt = state.characterPrompt;
  const previousBaseline = state.characterPromptBaseline;
  const previousSettings = JSON.stringify(state.promptSettings);
  const settings = { ...promptSettingsForCharacter(characterId) };
  const value = event.target.value;
  if (value.startsWith('preset:')) {
    settings.source = 'preset';
    settings.presetId = value.slice('preset:'.length);
    const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
    if (!preset) throw new Error('選択したプリセットが見つかりません');
    state.characterPrompt = preset.prompt;
  } else {
    settings.source = value;
    delete settings.presetId;
    if (value === 'saved' && settings.savedPrompt !== undefined) {
      state.characterPrompt = settings.savedPrompt;
    } else if (value === 'last' && settings.lastPrompt !== undefined) {
      state.characterPrompt = settings.lastPrompt;
    }
  }
  state.promptSettings.characters[characterId] = settings;
  try {
    await persistPromptSettings();
    state.characterPromptBaseline = state.characterPrompt;
    syncCombinedPrompt();
    renderCharacterView();
  } catch (error) {
    state.promptSettings = JSON.parse(previousSettings);
    state.characterPrompt = previousPrompt;
    state.characterPromptBaseline = previousBaseline;
    syncCombinedPrompt();
    setStatus(`設定保存失敗: ${error.message}`);
    renderCharacterView();
  }
}

async function changePromptSource(event) {
  if (!await confirmPromptSaveBeforeLeaving()) {
    renderCharacterView();
    return;
  }
  const dressId = state.selectedDress;
  const previousPrompt = state.dressPrompt;
  const previousBaseline = state.dressPromptBaseline;
  const previousSettings = JSON.stringify(state.promptSettings);
  const settings = { ...promptSettingsForDress(dressId) };
  const value = event.target.value;
  if (value.startsWith('preset:')) {
    settings.source = 'preset';
    settings.presetId = value.slice('preset:'.length);
    const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
    if (!preset) throw new Error('選択したプリセットが見つかりません');
    state.dressPrompt = preset.prompt;
  } else {
    settings.source = value;
    delete settings.presetId;
    if (value === 'saved' && settings.savedPrompt !== undefined) {
      state.dressPrompt = settings.savedPrompt;
    } else if (value === 'last' && settings.lastPrompt !== undefined) {
      state.dressPrompt = settings.lastPrompt;
    } else if (value === 'default') {
      state.dressPrompt = state.defaultPrompt;
    }
  }
  state.promptSettings.clothes[dressId] = settings;
  try {
    await persistPromptSettings();
    state.dressPromptBaseline = state.dressPrompt;
    syncCombinedPrompt();
    renderCharacterView();
  } catch (error) {
    state.promptSettings = JSON.parse(previousSettings);
    state.dressPrompt = previousPrompt;
    state.dressPromptBaseline = previousBaseline;
    syncCombinedPrompt();
    setStatus(`設定保存失敗: ${error.message}`);
    renderCharacterView();
  }
}

async function savePromptPreset(scope) {
  const isCharacter = scope === 'character';
  const nameInput = document.getElementById(isCharacter ? 'character-preset-name' : 'preset-name');
  const saveButton = document.getElementById(isCharacter ? 'save-character-preset' : 'save-preset');
  const name = nameInput.value.trim();
  if (!name) {
    setStatus('プリセット名を入力してください');
    return;
  }
  if (name.length > 100) {
    setStatus('プリセット名は100文字以内にしてください');
    return;
  }
  const previousSettings = JSON.stringify(state.promptSettings);
  saveButton.disabled = true;
  setStatus('プリセットを保存中…');
  try {
    const preset = {
      id: createPresetId(),
      name,
      prompt: isCharacter ? state.characterPrompt : state.dressPrompt,
      scope,
    };
    state.promptSettings.presets.push(preset);
    await persistPromptSettings();
    if (isCharacter) state.characterPromptBaseline = state.characterPrompt;
    else state.dressPromptBaseline = state.dressPrompt;
    setStatus(`プリセット「${name}」を保存しました。${isCharacter ? 'キャラ' : '服'}用の選択欄から選べます`);
    renderCharacterView();
  } catch (error) {
    state.promptSettings = JSON.parse(previousSettings);
    setStatus(`プリセット保存失敗: ${error.message}`);
  } finally {
    if (saveButton.isConnected) saveButton.disabled = false;
  }
}

async function updatePromptPreset(scope) {
  const isCharacter = scope === 'character';
  const settings = isCharacter
    ? promptSettingsForCharacter(state.currentCharacter)
    : promptSettingsForDress(state.selectedDress);
  const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
  if (!preset) return;
  const previousPrompt = preset.prompt;
  preset.prompt = isCharacter ? state.characterPrompt : state.dressPrompt;
  try {
    await persistPromptSettings();
    if (isCharacter) state.characterPromptBaseline = state.characterPrompt;
    else state.dressPromptBaseline = state.dressPrompt;
    setStatus(`プリセット「${preset.name}」を更新しました`);
  } catch (error) {
    preset.prompt = previousPrompt;
    setStatus(`プリセット更新失敗: ${error.message}`);
  }
}

async function deletePromptPreset(scope) {
  const isCharacter = scope === 'character';
  const settings = isCharacter
    ? promptSettingsForCharacter(state.currentCharacter)
    : promptSettingsForDress(state.selectedDress);
  const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
  if (!preset || !window.confirm(`プリセット「${preset.name}」を削除しますか？使用中の${isCharacter ? 'キャラ' : '服'}は共通の入力に切り替わります。`)) return;
  if (!await confirmPromptSaveBeforeLeaving()) return;

  const previousSettings = JSON.stringify(state.promptSettings);
  state.promptSettings.presets = state.promptSettings.presets.filter((item) => item.id !== preset.id);
  for (const [dressId, dressSettings] of Object.entries(state.promptSettings.clothes)) {
    if (dressSettings.presetId === preset.id) {
      dressSettings.source = 'shared';
      delete dressSettings.presetId;
    }
  }
  for (const characterSettings of Object.values(state.promptSettings.characters)) {
    if (characterSettings.presetId === preset.id) {
      characterSettings.source = 'shared';
      delete characterSettings.presetId;
    }
  }
  try {
    await persistPromptSettings();
    state.promptBaseline = state.prompt;
    renderCharacterView();
  } catch (error) {
    state.promptSettings = JSON.parse(previousSettings);
    setStatus(`プリセット削除失敗: ${error.message}`);
  }
}

async function generate(char, dressId, force = false, promptParts = null, dressVariantId = null) {
  if (state.busy) return;
  const generation = generationAvailability();
  if (generation.startable) {
    confirmStartComfyui();
    return;
  }
  if (!generation.available) {
    setStatus(generation.reason);
    return;
  }
  const seed = Number(state.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    setStatus('シードは0以上の整数を入力してください');
    return;
  }
  const characterPrompt = promptParts?.characterPrompt ?? state.characterPrompt;
  const dressPrompt = promptParts?.dressPrompt ?? state.dressPrompt;
  const prompt = combinePrompts(characterPrompt, dressPrompt);
  state.busy = true;
  renderCharacterView();
  try {
    const res = await api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character: char.id,
        dress: dressId,
        dressVariant: dressVariantId || selectedDressVariant(dressId),
        prompt,
        characterPrompt,
        dressPrompt,
        seed,
        force,
        disableLora: state.disableLora,
      }),
    });
    if (!generatedVersions(char, dressId).some((version) => version.url === res.url)) {
      char.generated[dressId] = [
        { file: res.file, url: res.url, createdAt: res.createdAt },
        ...generatedVersions(char, dressId),
      ];
    }
    if (res.status === 'generated') {
      const dressSettings = promptSettingsForDress(dressId);
      state.promptSettings.clothes[dressId] = { ...dressSettings, lastPrompt: dressPrompt };
      const characterSettings = promptSettingsForCharacter(char.id);
      state.promptSettings.characters[char.id] = { ...characterSettings, lastPrompt: characterPrompt };
      if (!promptParts) {
        state.dressPromptBaseline = state.dressPrompt;
        state.characterPromptBaseline = state.characterPrompt;
      }
      state.promptBaseline = state.prompt;
    }
    state.selectedGenerated[dressId] = res.url;
    setStatus(res.status === 'existing'
      ? '生成済みでした'
      : res.mock ? '生成しました（mock）' : '生成しました（ComfyUI）');
  } catch (e) {
    setStatus(`生成失敗: ${e.message}`);
  } finally {
    state.busy = false;
    renderCharacterView();
  }
}

async function generateAll() {
  const char = findCharacter(state.currentCharacter);
  const missing = state.catalog.clothes.filter((d) => !generatedVersions(char, d.id).length);
  if (generationAvailability().startable) {
    confirmStartComfyui();
    return;
  }
  for (const d of missing) {
    if (!generationAvailability().available) break;
    await generate(char, d.id, false, {
      characterPrompt: state.characterPrompt,
      dressPrompt: promptForSettings(promptSettingsForDress(d.id), state.dressPrompt),
    }, d.variants?.[0]?.id || d.id);
  }
}

function setStatus(msg) {
  state.status = msg;
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
  const imageManagerStatus = document.getElementById('image-manager-status');
  if (imageManagerStatus) imageManagerStatus.textContent = msg;
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (/\.(heic|heif)$/i.test(file.name)) {
        const mimeType = /\.heif$/i.test(file.name) ? 'image/heif' : 'image/heic';
        resolve(String(reader.result).replace(/^data:[^;]+;/, `data:${mimeType};`));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
    reader.readAsDataURL(file);
  });
}

function uploadFileAlias(file) {
  return file.name.replace(/\.[^.]+$/, '').trim().slice(0, 100);
}

async function uploadImage(event) {
  event.preventDefault();
  if (state.uploading) return;

  const form = event.currentTarget;
  const type = form.dataset.type;
  const files = Array.from(form.elements.image.files);
  if (!files.length) return;

  const buttons = Array.from(app.querySelectorAll('.upload-form button[type="submit"]'));
  state.uploading = true;
  buttons.forEach((button) => { button.disabled = true; });
  const failures = [];
  let uploaded = 0;
  const uploadedIds = [];

  try {
    for (const [index, file] of files.entries()) {
      if (file.size > 8 * 1024 * 1024) {
        failures.push(`${file.name}: 画像は8 MB以下にしてください`);
        continue;
      }

      const currentStatus = form.querySelector('.upload-status');
      if (currentStatus) currentStatus.textContent = `追加中… (${index + 1}/${files.length}) ${file.name}`;
      try {
        const image = await readImageAsDataUrl(file);
        const result = await api('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, alias: uploadFileAlias(file), image }),
        });
        uploaded += 1;
        uploadedIds.push(result.id);
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }

    let refreshError = null;
    if (uploaded) {
      try {
        await refreshCatalog();
        route();
      } catch (error) {
        refreshError = error;
      }
    }

    const summary = [`${uploaded}枚追加しました${uploadedIds.length ? `（${uploadedIds.join('、')}）` : ''}。`, ...failures, ...(refreshError ? [`一覧の更新に失敗しました: ${refreshError.message}`] : [])]
      .filter(Boolean)
      .join('\n');
    const result = app.querySelector(`.upload-form[data-type="${type}"] .upload-status`);
    if (result) result.textContent = summary;
  } finally {
    state.uploading = false;
    buttons.forEach((button) => {
      if (button.isConnected) button.disabled = false;
    });
  }
}

async function renameCatalogItem(event) {
  if (event.type === 'contextmenu') event.preventDefault();
  const form = event.currentTarget.matches('.catalog-edit-form')
    ? event.currentTarget
    : event.currentTarget.closest('.catalog-edit-form');
  if (!form) return;
  const items = form.dataset.type === 'character' ? state.catalog.characters : state.catalog.clothingImages;
  const currentItem = items.find((item) => item.id === form.dataset.id);
  if (!currentItem) return;
  const alias = window.prompt('表示名を入力してください', currentItem.name);
  if (alias === null) return;
  if (alias.length > 100) {
    form.querySelector('.upload-status').textContent = '名前は100文字以内にしてください';
    return;
  }
  const button = form.querySelector('[data-rename-catalog-item]');
  const status = form.querySelector('.upload-status');
  button.disabled = true;
  status.textContent = '保存中…';
  try {
    await api('/api/catalog-item', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: form.dataset.type,
        id: form.dataset.id,
        alias,
        group: currentItem?.group || '',
      }),
    });
    await refreshCatalog();
    renderCurrentView();
    const savedForm = [...app.querySelectorAll('.catalog-edit-form')]
      .find((item) => item.dataset.type === form.dataset.type && item.dataset.id === form.dataset.id);
    if (savedForm) {
      savedForm.querySelector('.upload-status').textContent = '名前を保存しました';
    }
  } catch (error) {
    if (status.isConnected) status.textContent = `名前の保存失敗: ${error.message}`;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function createCatalogGroup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.upload-status');
  button.disabled = true;
  status.textContent = '作成中…';
  try {
    const created = await api('/api/catalog-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: form.dataset.type, group: form.elements.group.value }),
    });
    state.organizerFolders[form.dataset.type] = created.group;
    await refreshCatalog();
    renderCurrentView();
    const organizer = app.querySelector(`.catalog-organizer[data-type="${form.dataset.type}"]`);
    const groupForm = organizer?.querySelector('.catalog-group-form');
    if (groupForm) {
      groupForm.querySelector('.upload-status').textContent = 'フォルダを作成しました。アイテムをドラッグして入れてください。';
      groupForm.elements.group.value = '';
    }
  } catch (error) {
    if (status.isConnected) status.textContent = `作成失敗: ${error.message}`;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function route() {
  teardownCharacterList();
  const m = location.hash.match(/^#\/char\/([A-Za-z0-9_-]+)/);
  const pageMatch = location.hash.match(/^#\/(clothes|editor|upload)(?:\/(character|clothes))?(?:\/|$)/);
  state.currentCharacter = m ? m[1] : null;
  state.routeHash = location.hash;
  state.page = pageMatch ? pageMatch[1] : 'home';
  // #/editor は旧URLそのままでもキャラ編集ページとして扱う
  if (state.page === 'editor') state.editorSection = pageMatch[2] === 'clothes' ? 'clothes' : 'character';
  if (state.currentCharacter) {
    const characterSettings = promptSettingsForCharacter(state.currentCharacter);
    if (characterSettings.source === 'preset') {
      const preset = state.promptSettings.presets.find((item) => item.id === characterSettings.presetId);
      if (preset) state.characterPrompt = preset.prompt;
    } else if (characterSettings.source === 'saved' && characterSettings.savedPrompt !== undefined) {
      state.characterPrompt = characterSettings.savedPrompt;
    } else if (characterSettings.source === 'last' && characterSettings.lastPrompt !== undefined) {
      state.characterPrompt = characterSettings.lastPrompt;
    }
    state.characterPromptBaseline = state.characterPrompt;
    if (state.selectedDress) {
      const dressSettings = promptSettingsForDress(state.selectedDress);
      if (dressSettings.source === 'preset') {
        const preset = state.promptSettings.presets.find((item) => item.id === dressSettings.presetId);
        if (preset) state.dressPrompt = preset.prompt;
      } else if (dressSettings.source === 'saved' && dressSettings.savedPrompt !== undefined) {
        state.dressPrompt = dressSettings.savedPrompt;
      } else if (dressSettings.source === 'last' && dressSettings.lastPrompt !== undefined) {
        state.dressPrompt = dressSettings.lastPrompt;
      } else if (dressSettings.source === 'default') {
        state.dressPrompt = state.defaultPrompt;
      }
      state.dressPromptBaseline = state.dressPrompt;
    }
    syncCombinedPrompt();
    renderCharacterView();
  } else renderCurrentView();
}

function renderCurrentView() {
  if (state.currentCharacter) renderCharacterView();
  else if (state.page === 'clothes') renderClothesPage();
  else if (state.page === 'editor') renderCatalogEditorPage(state.editorSection);
  else if (state.page === 'upload') renderUploadPage();
  else renderCharacterList();
}

// ---------------------------------------------------------------------------
// server status (アクセス時と画面遷移時のみ確認。定期チェックはしない)
// ---------------------------------------------------------------------------

let serverStatusRequestId = 0;
let wakeInFlight = false;

async function refreshServerStatus() {
  const el = document.getElementById('server-status');
  if (!el) return;
  if (wakeInFlight) return;
  const wakeButton = document.getElementById('wake-button');
  const requestId = ++serverStatusRequestId;
  if (wakeButton) wakeButton.hidden = true;
  el.dataset.state = 'checking';
  el.textContent = '確認中…';
  let status;
  try {
    const res = await fetch('/api/server-status', { cache: 'no-store' });
    status = res.ok ? await res.json() : null;
  } catch {
    status = null;
  }
  if (requestId !== serverStatusRequestId) return;
  lastServerStatus = status;
  // 同じ確認結果を服フィルタと生成ボタンにも使う（画面遷移ごとの追加リクエストはしない）
  if (status) {
    setComfyuiStatus(status.mock || status.comfyui ? 'ready' : status.starting ? 'starting' : 'down', {
      mock: status.mock === true,
      startAvailable: status.startAvailable === true,
      autoStart: status.autoStart === true,
    });
  }
  // 起動ボタン: COMFYUI_START_TASK があれば WOL も含めた「ComfyUI を起動」、なければ PC 停止中だけ WOL の「起動」
  const startable = status && !status.mock && !status.comfyui && !status.starting && status.startAvailable
    && (status.server || status.wakeAvailable);
  if (wakeButton && startable) {
    wakeButton.hidden = false;
    wakeButton.disabled = false;
    wakeButton.textContent = 'ComfyUI を起動';
  }
  if (!status) {
    markComfyuiStatusUnconfirmed();
    el.dataset.state = 'down';
    el.textContent = '状態を取得できません';
    el.title = 'kisekae3 サーバーに接続できませんでした';
  } else if (status.mock) {
    el.dataset.state = 'ok';
    el.textContent = 'モック生成';
    el.title = 'GENERATOR=mock で動作中';
  } else if (status.comfyui) {
    el.dataset.state = 'ok';
    el.textContent = 'ComfyUI 稼働中';
    el.title = `${status.host}: PC 起動中 / ComfyUI 応答あり`;
  } else if (status.starting) {
    showEnsureProgress(status.ensure);
  } else if (status.server) {
    el.dataset.state = 'comfyui-down';
    el.textContent = 'ComfyUI 停止中';
    el.title = `${status.host}: PC は起動中ですが ComfyUI が応答しません`;
  } else {
    el.dataset.state = 'down';
    el.textContent = 'PC 停止中';
    el.title = `${status.host}: PC が応答しません（スリープ中の可能性）`;
    if (wakeButton && status.wakeAvailable && !status.startAvailable) {
      wakeButton.hidden = false;
      wakeButton.disabled = false;
      wakeButton.textContent = '起動';
    }
  }
}

async function wakeServer() {
  const wakeButton = document.getElementById('wake-button');
  const el = document.getElementById('server-status');
  if (!el) return;
  wakeInFlight = true;
  serverStatusRequestId++; // 送信中に届く古い状態レスポンスを破棄する
  wakeButton.disabled = true;
  wakeButton.textContent = '送信中…';
  try {
    const res = await fetch('/api/wake', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    wakeButton.hidden = true;
    el.dataset.state = 'checking';
    el.textContent = '起動信号を送信しました';
    el.title = '起動まで少し待ってから、再読み込みか画面遷移で状態を再確認してください';
  } catch (e) {
    wakeButton.disabled = false;
    wakeButton.textContent = '起動';
    alert(`起動信号を送れませんでした: ${e.message}`);
  }
  wakeInFlight = false;
}

// ---------------------------------------------------------------------------
// ComfyUI のオンデマンド起動（COMFYUI_START_TASK 設定時）
// 状態確認はアクセス時と画面遷移時だけだが、このタブで起動を始めたときだけ、
// 終わるまで 5 秒ごとに進み具合（GET /api/comfyui/ensure）を確認する。
// ---------------------------------------------------------------------------

const ENSURE_POLL_INTERVAL_MS = 5000;
const ENSURE_POLL_MAX_FAILURES = 3; // 進み具合を続けてこの回数取得できなかったら確認をやめる
const ENSURE_PHASE_LABELS = {
  checking: '確認中',
  waking: 'PC を起動中',
  waiting_pc: 'PC の起動待ち',
  starting: 'ComfyUI を起動中',
  waiting_comfyui: 'ComfyUI の起動待ち',
};
let lastServerStatus = null;
let ensurePollTimer = 0;
let ensurePollFailures = 0;

function showEnsureProgress(ensure) {
  const el = document.getElementById('server-status');
  if (!el) return;
  el.dataset.state = 'starting';
  el.textContent = `ComfyUI 起動中…（${ENSURE_PHASE_LABELS[ensure?.phase] || '処理中'}）`;
  el.title = ensure?.message || 'ComfyUI を起動しています';
}

function confirmStartComfyui() {
  if (!window.confirm('ComfyUI が応答していません。ComfyUI を起動しますか？\n（PC の起動やモデルの読み込みで数分かかることがあります）')) return;
  startComfyui();
}

async function startComfyui({ force = false } = {}) {
  const wakeButton = document.getElementById('wake-button');
  if (wakeButton) {
    wakeButton.disabled = true;
    wakeButton.textContent = '起動中…';
  }
  try {
    const res = await fetch('/api/comfyui/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(force ? { force: true } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    serverStatusRequestId++; // 送信前に始まった状態確認の古い結果を捨てる
    if (wakeButton) wakeButton.hidden = true;
    handleEnsureProgress(body);
  } catch (e) {
    if (wakeButton) {
      wakeButton.disabled = false;
      wakeButton.textContent = 'ComfyUI を起動';
    }
    alert(`ComfyUI の起動を始められませんでした: ${e.message}`);
  }
}

function handleEnsureProgress(ensure) {
  clearTimeout(ensurePollTimer);
  ensurePollTimer = 0;
  if (ensure.inProgress) {
    setComfyuiStatus('starting');
    showEnsureProgress(ensure);
    setStatus(ensure.message || 'ComfyUI を起動しています');
    ensurePollTimer = setTimeout(pollEnsureProgress, ENSURE_POLL_INTERVAL_MS);
    return;
  }
  finishEnsure(ensure);
}

async function pollEnsureProgress() {
  let ensure;
  try {
    const res = await fetch('/api/comfyui/ensure', { cache: 'no-store' });
    ensure = res.ok ? await res.json() : null;
  } catch {
    ensure = null;
  }
  // 一時的に取得できなかったときは次の周期でもう一度確認する。続けて失敗したらやめる
  if (!ensure) {
    ensurePollFailures++;
    if (ensurePollFailures >= ENSURE_POLL_MAX_FAILURES) {
      ensurePollFailures = 0;
      ensurePollTimer = 0;
      setStatus('ComfyUI の起動状況を確認できなくなりました。しばらくしてから再読み込みしてください');
      refreshServerStatus();
      return;
    }
    ensurePollTimer = setTimeout(pollEnsureProgress, ENSURE_POLL_INTERVAL_MS);
    return;
  }
  ensurePollFailures = 0;
  handleEnsureProgress(ensure);
}

async function finishEnsure(ensure) {
  if (ensure.phase === 'ready' || ensure.phase === 'already_running') {
    const warnings = ensure.warnings?.length ? `（注意: ${ensure.warnings.join(' / ')}）` : '';
    const done = ensure.phase === 'already_running' ? 'ComfyUI はすでに起動しています' : 'ComfyUI が起動しました';
    setStatus(`${done}。もう一度生成ボタンを押してください${warnings}`);
    await refreshServerStatus();
    return;
  }
  await refreshServerStatus();
  if (ensure.phase === 'blocked_vram') {
    if (window.confirm(`${ensure.message}\nそれでも ComfyUI を起動しますか？`)) startComfyui({ force: true });
    else setStatus(ensure.message);
    return;
  }
  setStatus(ensure.message || 'ComfyUI を起動できませんでした');
  alert(ensure.message || 'ComfyUI を起動できませんでした');
}

document.getElementById('wake-button')?.addEventListener('click', () => {
  if (lastServerStatus?.startAvailable) startComfyui();
  else wakeServer();
});

refreshServerStatus();

window.addEventListener('hashchange', async () => {
  if (!await confirmPromptSaveBeforeLeaving()) {
    location.hash = state.routeHash;
    return;
  }
  refreshServerStatus();
  route();
});

window.addEventListener('beforeunload', (event) => {
  if (!isPromptDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

(async function init() {
  await refreshCatalog();
  const config = await api('/api/config');
  state.promptSettings = await api('/api/prompt-settings');
  state.defaultPrompt = config.prompt;
  state.characterPrompt = '';
  state.characterPromptBaseline = '';
  state.dressPrompt = state.defaultPrompt;
  state.dressPromptBaseline = state.defaultPrompt;
  state.prompt = state.defaultPrompt;
  state.promptBaseline = state.defaultPrompt;
  state.seed = config.seed ?? 0;
  route();
})();
