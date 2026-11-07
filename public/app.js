const app = document.getElementById('app');
const themeToggle = document.getElementById('theme-toggle');
const state = {
  catalog: null,
  selectedCatalogItems: { character: new Set(), clothes: new Set() },
  catalogFolders: { characters: '', clothes: '' },
  characterSort: 'generated',
  characterPage: 1,
  randomFolderActive: false,
  randomCharacterIds: [],
  characterThumbnailFit: localStorage.getItem('kisekae3-character-thumbnail-fit') === 'cover' ? 'cover' : 'contain',
  organizerFolders: { character: '', clothes: '' },
  organizerOpen: { character: true, clothes: true },
  dressFolder: '',
  currentCharacter: null, // char id when on character view
  selectedDress: null,    // dress id on character view
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
  defaultPrompt: '',
  promptSettings: { presets: [], clothes: {} },
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

function chooseRandomCharacters(characters, count) {
  const shuffled = [...characters];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function generatedVersions(char, dressId) {
  return char.generated[dressId] || [];
}

function promptSettingsForDress(dressId) {
  return state.promptSettings.clothes[dressId] || { source: 'shared' };
}

function isPromptDirty() {
  return state.prompt !== state.promptBaseline;
}

async function persistPromptSettings() {
  state.promptSettings = await api('/api/prompt-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.promptSettings),
  });
}

async function savePromptForCurrentDress() {
  if (!state.selectedDress) return;
  const settings = promptSettingsForDress(state.selectedDress);
  state.promptSettings.clothes[state.selectedDress] = {
    ...settings,
    source: 'saved',
    savedPrompt: state.prompt,
  };
  await persistPromptSettings();
  state.promptBaseline = state.prompt;
}

async function confirmPromptSaveBeforeLeaving() {
  if (!isPromptDirty()) return true;
  if (!window.confirm('未保存のプロンプトがあります。現在の服の保存済みプロンプトとして保存しますか？\n「いいえ」を選ぶと保存せずに続行します。')) {
    return true;
  }
  try {
    await savePromptForCurrentDress();
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

function renderCharacterList() {
  app.querySelectorAll('.catalog-organizer').forEach((organizer) => {
    state.organizerOpen[organizer.dataset.type] = organizer.open;
  });
  app.className = 'home-page';
  const characterFolders = groupedCatalogItems(state.catalog.characters, state.catalog.groups.characters);
  const clothesFolders = groupedCatalogItems(state.catalog.clothes, state.catalog.groups.clothes);
  const visibleCharacters = state.randomFolderActive
    ? state.randomCharacterIds.map((id) => state.catalog.characters.find((character) => character.id === id)).filter(Boolean)
    : characterFolders.find(([group]) => group === state.catalogFolders.characters)?.[1] || [];
  const visibleClothes = clothesFolders.find(([group]) => group === state.catalogFolders.clothes)?.[1] || [];
  const sortedCharacters = [...visibleCharacters];
  if (state.characterSort === 'generated') {
    sortedCharacters.sort((a, b) => generatedCount(b) - generatedCount(a));
  } else if (state.characterSort === 'recent') {
    sortedCharacters.sort((a, b) => latestGeneratedAt(b) - latestGeneratedAt(a));
  }
  const pageCount = Math.ceil(sortedCharacters.length / 30);
  state.characterPage = Math.min(state.characterPage, Math.max(pageCount, 1));
  const pageCharacters = sortedCharacters.slice((state.characterPage - 1) * 30, state.characterPage * 30);
  const cards = pageCharacters.map((c) => `
    <a class="card character-card ${state.characterThumbnailFit === 'contain' ? 'fit-contain' : ''}" href="#/char/${esc(c.id)}" aria-label="${esc(c.name)}">
      ${c.iconUrl ? `<img src="${c.iconUrl}" alt="" loading="lazy" />` : '<div class="noimg">No icon</div>'}
      <div class="meta">
        <span class="count">${generatedCount(c)} / ${state.catalog.clothes.length} 生成済み</span>
      </div>
    </a>`).join('');
  const clothes = visibleClothes.map((d) => `
    <div class="card small"><img src="${d.url}" alt="${esc(d.name)}" loading="lazy" /><div class="meta"><strong>${esc(d.name)}</strong></div></div>`).join('');
  const characterListControls = (state.randomFolderActive || state.catalogFolders.characters !== null) && visibleCharacters.length
    ? `<div class="character-list-toolbar">
        <label for="character-sort">並び替え</label>
        <select id="character-sort">
          <option value="default" ${state.characterSort === 'default' ? 'selected' : ''}>登録順</option>
          <option value="generated" ${state.characterSort === 'generated' ? 'selected' : ''}>生成数が多い順</option>
          <option value="recent" ${state.characterSort === 'recent' ? 'selected' : ''}>最近生成した順</option>
        </select>
        <label for="character-thumbnail-fit">サムネイル</label>
        <select id="character-thumbnail-fit">
          <option value="cover" ${state.characterThumbnailFit === 'cover' ? 'selected' : ''}>余白なし</option>
          <option value="contain" ${state.characterThumbnailFit === 'contain' ? 'selected' : ''}>全体を表示</option>
        </select>
        <span class="character-list-count">${visibleCharacters.length}キャラ</span>
      </div>
      ${pageCount > 1 ? `<nav class="character-pagination" aria-label="キャラ一覧のページ">
        <button type="button" data-character-page="${state.characterPage - 1}" ${state.characterPage === 1 ? 'disabled' : ''}>前へ</button>
        <span>${state.characterPage} / ${pageCount}ページ</span>
        <button type="button" data-character-page="${state.characterPage + 1}" ${state.characterPage === pageCount ? 'disabled' : ''}>次へ</button>
      </nav>` : ''}`
    : '';
  app.innerHTML = `
    <h2>キャラを選ぶ</h2>
    ${state.catalog.characters.length ? `
      ${renderFolderPicker(characterFolders, state.catalogFolders.characters, 'characters', 'characters', true, state.randomFolderActive)}
      ${!state.randomFolderActive && state.catalogFolders.characters === null
        ? '<p class="empty">フォルダを選ぶと中身が表示されます。</p>'
        : visibleCharacters.length ? `${characterListControls}<div class="grid">${cards}</div>` : '<p class="empty">このフォルダにキャラはいません。</p>'}`
      : '<p class="empty">store/characters/ に chara1.png のような画像を追加してください。</p>'}
    <details class="upload-section">
      <summary>キャラ・服を追加</summary>
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
    </details>
    <details class="catalog-clothes clothes-browser">
      <summary>登録済みの服を一覧表示</summary>
      ${state.catalog.clothes.length ? `
        ${renderFolderPicker(clothesFolders, state.catalogFolders.clothes, 'clothes')}
        ${state.catalogFolders.clothes === null
          ? '<p class="empty">フォルダを選ぶと中身が表示されます。</p>'
          : `<div class="grid small">${clothes || '<p class="empty">このフォルダに服はありません。</p>'}</div>`}`
        : '<p class="empty">store/clothes/ に服の画像を追加してください。</p>'}
    </details>
    <details class="catalog-clothes catalog-editor">
      <summary>登録済みデータの表示名・フォルダを編集</summary>
      <p class="hint">画像または左上のチェックで複数選択し、選択項目のつまみ（⠿）をフォルダへドラッグするとまとめて移動します。</p>
      ${renderCatalogOrganizer('character', state.catalog.characters, state.catalog.groups.characters)}
      ${renderCatalogOrganizer('clothes', state.catalog.clothes, state.catalog.groups.clothes)}
    </details>`;

  app.querySelector('#character-sort')?.addEventListener('change', (event) => {
    state.characterSort = event.currentTarget.value;
    state.characterPage = 1;
    renderCharacterList();
  });
  app.querySelector('#character-thumbnail-fit')?.addEventListener('change', (event) => {
    state.characterThumbnailFit = event.currentTarget.value;
    localStorage.setItem('kisekae3-character-thumbnail-fit', state.characterThumbnailFit);
    renderCharacterList();
  });
  app.querySelectorAll('[data-character-page]').forEach((button) => {
    button.addEventListener('click', () => {
      state.characterPage = Number(button.dataset.characterPage);
      renderCharacterList();
    });
  });
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
  app.querySelectorAll('.catalog-edit-form').forEach((form) => {
    form.addEventListener('submit', saveCatalogItem);
  });
  app.querySelectorAll('.catalog-item-select').forEach((checkbox) => {
    checkbox.addEventListener('change', updateCatalogSelection);
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
  app.querySelectorAll('.catalog-organizer').forEach((organizer) => {
    organizer.addEventListener('toggle', () => {
      state.organizerOpen[organizer.dataset.type] = organizer.open;
    });
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

function renderFolderPicker(folders, activeGroup, view, type = view, includeRandom = false, randomActive = false) {
  return `
    <nav class="catalog-folder-picker" aria-label="フォルダ">
      ${folders.map(([group, items]) => `
        <button type="button" class="catalog-folder ${!randomActive && activeGroup === group ? 'active' : ''}"
          data-folder-view="${view}" data-type="${type}" data-group="${esc(group)}"
          title="${esc(group || '未分類')} (${items.length})"
          aria-label="${esc(group || '未分類')}、${items.length}件"
          aria-pressed="${!randomActive && activeGroup === group}">
          <span class="catalog-folder-icon" aria-hidden="true">📁</span>
          <span class="catalog-folder-label">${esc(group || '未分類')}</span>
        </button>`).join('')}
      ${includeRandom ? `
        <button type="button" class="catalog-folder ${randomActive ? 'active' : ''}"
          data-folder-view="${view}" data-type="${type}" data-random-folder="true"
          title="全キャラから${Math.min(6, state.catalog.characters.length)}人をランダムに選択"
          aria-label="ランダム、全キャラから${Math.min(6, state.catalog.characters.length)}人を選択"
          aria-pressed="${randomActive}">
          <span class="catalog-folder-icon" aria-hidden="true">🎲</span>
          <span class="catalog-folder-label">ランダム</span>
        </button>` : ''}
    </nav>`;
}

function selectCatalogFolder(event) {
  const { folderView, type, group, randomFolder } = event.currentTarget.dataset;
  if (folderView === 'organizer') {
    state.organizerFolders[type] = group;
    state.selectedCatalogItems[type].clear();
    renderCharacterList();
    const editor = app.querySelector('.catalog-editor');
    if (editor) editor.open = true;
    return;
  }
  if (folderView === 'characters' || folderView === 'clothes') {
    if (folderView === 'characters' && randomFolder === 'true') {
      state.randomFolderActive = true;
      state.randomCharacterIds = chooseRandomCharacters(state.catalog.characters, 6).map((character) => character.id);
      state.characterPage = 1;
      renderCharacterList();
      return;
    }
    state.catalogFolders[folderView] = group;
    if (folderView === 'characters') {
      state.randomFolderActive = false;
      state.characterPage = 1;
    }
    renderCharacterList();
    if (folderView === 'clothes') {
      const clothesBrowser = app.querySelector('.clothes-browser');
      if (clothesBrowser) clothesBrowser.open = true;
    }
    return;
  }
  if (folderView === 'dress') {
    state.dressFolder = group;
    renderCharacterView();
  }
}

function renderCatalogOrganizer(type, items, declaredGroups) {
  const typeName = type === 'character' ? 'キャラ' : '服';
  const groupedItems = groupedCatalogItems(items, declaredGroups);
  const activeGroup = state.organizerFolders[type];
  const activeItems = groupedItems.find(([group]) => group === activeGroup)?.[1] || [];
  return `
    <details class="catalog-organizer" data-type="${type}" ${state.organizerOpen[type] ? 'open' : ''}>
      <summary>${typeName}の編集 (${items.length}件)</summary>
      <form class="catalog-group-form" data-type="${type}">
        <label>新しいフォルダ<input name="group" type="text" maxlength="100" required placeholder="例: 夏服" /></label>
        <button type="submit">フォルダを作成</button>
        <span class="upload-status" role="status"></span>
      </form>
      <p class="catalog-selection-status" data-type="${type}" role="status">チェックで複数選択し、選択項目のつまみをドラッグするとまとめて移動できます。</p>
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
                  <span class="catalog-id">${typeName} · ${esc(item.id)}</span>
                  <input name="alias" type="text" maxlength="100" value="${esc(item.name)}" aria-label="表示名" />
                  <button type="submit">保存</button>
                  <span class="upload-status" role="status"></span>
                </form>`).join('') : '<p class="empty">このフォルダは空です。</p>'}
            </div>
          </section>`}
    </details>`;
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
  const items = forms.map((form) => ({ id: form.dataset.id, alias: form.elements.alias.value }));

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
    renderCharacterList();
    const editor = app.querySelector('.catalog-editor');
    if (editor) editor.open = true;
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
  const selectedDressName = state.catalog.clothes.find((dress) => dress.id === sel)?.name || sel;
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
  const visibleDresses = dressFolders.find(([group]) => group === state.dressFolder)?.[1] || [];
  const generatedTotal = versions.length;
  const stageSrc = state.stageDisplayedSrc || displaySrc;
  const dressPromptSettings = sel ? promptSettingsForDress(sel) : { source: 'shared' };
  const activePreset = state.promptSettings.presets.find((preset) => (
    dressPromptSettings.source === 'preset' && preset.id === dressPromptSettings.presetId
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
        ${state.dressFolder === null
          ? '<p class="empty">フォルダを選ぶと服が表示されます。</p>'
          : `<div class="dress-grid">${visibleDresses.map((d) => {
            const done = generatedVersions(char, d.id).length > 0;
            return `
            <button class="card small dress ${d.id === sel ? 'selected' : ''}" data-dress="${esc(d.id)}" aria-label="${esc(d.name)}">
              <img src="${d.url}" alt="" loading="lazy" />
              <div class="meta">
                <span class="badge ${done ? 'done' : 'todo'}">${done ? '生成済み' : '未生成'}</span>
              </div>
            </button>`;
          }).join('')}</div>`}
        <div class="dress-folder-picker">${renderFolderPicker(dressFolders, state.dressFolder, 'dress')}</div>
        ${sel ? `<p class="stage-caption">
          選択中の服: ${selUrl ? `生成済み (${versions.length}件)` : '未生成'}
        </p>` : ''}
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
          <label for="generation-settings-prompt">プロンプト</label>
          <textarea id="generation-settings-prompt" rows="8" readonly></textarea>
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
          <button id="generate-all" ${missing.length ? '' : 'disabled'}>未生成を一括生成 (${missing.length})</button>
          ${sel && !versions.length ? '<button id="generate-selected">この服を生成</button>' : ''}
          <button id="regenerate-selected" ${sel && versions.length ? '' : 'disabled'}>選択中を再生成</button>
          <span id="status" role="status">${esc(state.status)}</span>
        </div>
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
          <label for="prompt">生成プロンプト</label>
          <textarea id="prompt" rows="5">${esc(state.prompt)}</textarea>
          <label for="prompt-source">この服で使うプロンプト</label>
          <select id="prompt-source" ${sel ? '' : 'disabled'}>
            <option value="shared" ${dressPromptSettings.source === 'shared' ? 'selected' : ''}>共通の入力を引き継ぐ</option>
            <option value="default" ${dressPromptSettings.source === 'default' ? 'selected' : ''}>デフォルトプロンプト</option>
            ${dressPromptSettings.savedPrompt !== undefined ? `<option value="saved" ${dressPromptSettings.source === 'saved' ? 'selected' : ''}>この服に保存したプロンプト</option>` : ''}
            ${dressPromptSettings.lastPrompt !== undefined ? `<option value="last" ${dressPromptSettings.source === 'last' ? 'selected' : ''}>この服の最後の生成プロンプト</option>` : ''}
            ${state.promptSettings.presets.map((preset) => `
              <option value="preset:${esc(preset.id)}" ${dressPromptSettings.source === 'preset' && dressPromptSettings.presetId === preset.id ? 'selected' : ''}>プリセット: ${esc(preset.name)}</option>`).join('')}
          </select>
          <div class="prompt-preset-actions">
            <label for="preset-name">プリセット名</label>
            <input id="preset-name" type="text" maxlength="100" placeholder="例: 上下セット" />
            <button id="save-preset" type="button">現在のプロンプトを保存</button>
            <button id="update-preset" type="button" ${activePreset ? '' : 'disabled'}>選択中を更新</button>
            <button id="delete-preset" type="button" ${activePreset ? '' : 'disabled'}>選択中を削除</button>
          </div>
          <p class="hint">プリセットを保存しても、現在の服への適用は自動で変わりません。使う場合は上の選択欄から選んでください。</p>
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
  document.getElementById('prompt').addEventListener('input', (event) => {
    state.prompt = event.target.value;
  });
  document.getElementById('prompt-source').addEventListener('change', changePromptSource);
  document.getElementById('save-preset').addEventListener('click', savePromptPreset);
  document.getElementById('update-preset').addEventListener('click', updatePromptPreset);
  document.getElementById('delete-preset').addEventListener('click', deletePromptPreset);
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
    regenerateBtn.addEventListener('click', () => generate(char, sel, true));
  }
  const generateSelectedBtn = document.getElementById('generate-selected');
  if (generateSelectedBtn) {
    generateSelectedBtn.disabled = state.busy;
    generateSelectedBtn.addEventListener('click', () => generate(char, sel));
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
    renderCharacterList();
    const editor = app.querySelector('.catalog-editor');
    if (editor) editor.open = true;
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
    renderCharacterList();
    const editor = app.querySelector('.catalog-editor');
    if (editor) editor.open = true;
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
    if (!generatedVersions(char, dressId).length) await generate(char, dressId);
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
    if (preset) state.prompt = preset.prompt;
  } else if (settings.source === 'saved' && settings.savedPrompt !== undefined) {
    state.prompt = settings.savedPrompt;
  } else if (settings.source === 'last' && settings.lastPrompt !== undefined) {
    state.prompt = settings.lastPrompt;
  } else if (settings.source === 'default') {
    state.prompt = state.defaultPrompt;
  }
  state.promptBaseline = state.prompt;
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
  const prompt = document.getElementById('generation-settings-prompt');
  const seed = document.getElementById('generation-settings-seed');
  const lora = document.getElementById('generation-settings-lora');
  const status = document.getElementById('generation-settings-status');
  const applyButton = document.getElementById('apply-generation-settings');
  state.generationSettings = null;
  prompt.value = '';
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
    prompt.value = settings.prompt ?? '';
    seed.textContent = settings.seed === null ? '記録なし' : String(settings.seed);
    lora.textContent = typeof settings.disableLora === 'boolean'
      ? settings.disableLora ? '使わない' : '使う'
      : '記録なし';
    const hasSettings = settings.prompt !== null || settings.seed !== null
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
  if (typeof settings.prompt === 'string') state.prompt = settings.prompt;
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

async function changePromptSource(event) {
  if (!await confirmPromptSaveBeforeLeaving()) {
    renderCharacterView();
    return;
  }
  const dressId = state.selectedDress;
  const previousPrompt = state.prompt;
  const previousBaseline = state.promptBaseline;
  const previousSettings = JSON.stringify(state.promptSettings);
  const settings = { ...promptSettingsForDress(dressId) };
  const value = event.target.value;
  if (value.startsWith('preset:')) {
    settings.source = 'preset';
    settings.presetId = value.slice('preset:'.length);
    const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
    if (!preset) throw new Error('選択したプリセットが見つかりません');
    state.prompt = preset.prompt;
  } else {
    settings.source = value;
    delete settings.presetId;
    if (value === 'saved' && settings.savedPrompt !== undefined) {
      state.prompt = settings.savedPrompt;
    } else if (value === 'last' && settings.lastPrompt !== undefined) {
      state.prompt = settings.lastPrompt;
    } else if (value === 'default') {
      state.prompt = state.defaultPrompt;
    }
  }
  state.promptSettings.clothes[dressId] = settings;
  try {
    await persistPromptSettings();
    state.promptBaseline = state.prompt;
    renderCharacterView();
  } catch (error) {
    state.promptSettings = JSON.parse(previousSettings);
    state.prompt = previousPrompt;
    state.promptBaseline = previousBaseline;
    setStatus(`設定保存失敗: ${error.message}`);
    renderCharacterView();
  }
}

async function savePromptPreset() {
  const nameInput = document.getElementById('preset-name');
  const saveButton = document.getElementById('save-preset');
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
    const preset = { id: createPresetId(), name, prompt: state.prompt };
    state.promptSettings.presets.push(preset);
    await persistPromptSettings();
    state.promptBaseline = state.prompt;
    setStatus(`プリセット「${name}」を保存しました。使う服で選択してください`);
    renderCharacterView();
  } catch (error) {
    state.promptSettings = JSON.parse(previousSettings);
    setStatus(`プリセット保存失敗: ${error.message}`);
  } finally {
    if (saveButton.isConnected) saveButton.disabled = false;
  }
}

async function updatePromptPreset() {
  const settings = promptSettingsForDress(state.selectedDress);
  const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
  if (!preset) return;
  const previousPrompt = preset.prompt;
  preset.prompt = state.prompt;
  try {
    await persistPromptSettings();
    state.promptBaseline = state.prompt;
    setStatus(`プリセット「${preset.name}」を更新しました`);
  } catch (error) {
    preset.prompt = previousPrompt;
    setStatus(`プリセット更新失敗: ${error.message}`);
  }
}

async function deletePromptPreset() {
  const settings = promptSettingsForDress(state.selectedDress);
  const preset = state.promptSettings.presets.find((item) => item.id === settings.presetId);
  if (!preset || !window.confirm(`プリセット「${preset.name}」を削除しますか？使用中の服は共通の入力に切り替わります。`)) return;
  if (!await confirmPromptSaveBeforeLeaving()) return;

  const previousSettings = JSON.stringify(state.promptSettings);
  state.promptSettings.presets = state.promptSettings.presets.filter((item) => item.id !== preset.id);
  for (const [dressId, dressSettings] of Object.entries(state.promptSettings.clothes)) {
    if (dressSettings.presetId === preset.id) {
      dressSettings.source = 'shared';
      delete dressSettings.presetId;
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

async function generate(char, dressId, force = false) {
  if (state.busy) return;
  const seed = Number(state.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    setStatus('シードは0以上の整数を入力してください');
    return;
  }
  state.busy = true;
  renderCharacterView();
  try {
    const res = await api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character: char.id,
        dress: dressId,
        prompt: state.prompt,
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
      const settings = promptSettingsForDress(dressId);
      state.promptSettings.clothes[dressId] = { ...settings, lastPrompt: state.prompt };
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
  for (const d of missing) {
    await generate(char, d.id);
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
    if (result) {
      const section = app.querySelector('.upload-section');
      if (section) section.open = true;
      result.textContent = summary;
    }
  } finally {
    state.uploading = false;
    buttons.forEach((button) => {
      if (button.isConnected) button.disabled = false;
    });
  }
}

async function saveCatalogItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.upload-status');
  button.disabled = true;
  status.textContent = '保存中…';
  try {
    const items = form.dataset.type === 'character' ? state.catalog.characters : state.catalog.clothes;
    const currentItem = items.find((item) => item.id === form.dataset.id);
    await api('/api/catalog-item', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: form.dataset.type,
        id: form.dataset.id,
        alias: form.elements.alias.value,
        group: currentItem?.group || '',
      }),
    });
    await refreshCatalog();
    renderCharacterList();
    const savedForm = [...app.querySelectorAll('.catalog-edit-form')]
      .find((item) => item.dataset.type === form.dataset.type && item.dataset.id === form.dataset.id);
    if (savedForm) {
      const details = savedForm.closest('details');
      if (details) details.open = true;
      savedForm.querySelector('.upload-status').textContent = '保存しました';
    }
  } catch (error) {
    if (status.isConnected) status.textContent = `保存失敗: ${error.message}`;
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
    renderCharacterList();
    const editor = app.querySelector('.catalog-editor');
    if (editor) editor.open = true;
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
  const m = location.hash.match(/^#\/char\/([A-Za-z0-9_-]+)/);
  state.currentCharacter = m ? m[1] : null;
  state.routeHash = location.hash;
  if (state.currentCharacter) renderCharacterView();
  else renderCharacterList();
}

window.addEventListener('hashchange', async () => {
  if (!await confirmPromptSaveBeforeLeaving()) {
    location.hash = state.routeHash;
    return;
  }
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
  state.prompt = state.defaultPrompt;
  state.promptBaseline = config.prompt;
  state.seed = config.seed ?? 0;
  route();
})();
