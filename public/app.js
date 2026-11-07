const app = document.getElementById('app');
const themeToggle = document.getElementById('theme-toggle');
const state = {
  catalog: null,
  currentCharacter: null, // char id when on character view
  selectedDress: null,    // dress id on character view
  selectedGenerated: {},  // selected generated image URL per dress
  stageImageRequest: 0,
  busy: false,
  uploading: false,
  prompt: '',
  promptBaseline: '',
  defaultPrompt: '',
  promptSettings: { presets: [], clothes: {} },
  seed: 0,
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
  app.className = 'home-page';
  const cards = state.catalog.characters.map((c) => `
    <a class="card" href="#/char/${esc(c.id)}">
      ${c.iconUrl ? `<img src="${c.iconUrl}" alt="${esc(c.name)}" loading="lazy" />` : '<div class="noimg">No icon</div>'}
      <div class="meta">
        <strong>${esc(c.name)}</strong>
        <span class="count">${generatedCount(c)} / ${state.catalog.clothes.length} 生成済み</span>
      </div>
    </a>`).join('');

  app.innerHTML = `
    <h2>キャラを選ぶ</h2>
    ${state.catalog.characters.length ? `<div class="grid">${cards}</div>` : '<p class="empty">store/characters/ に chara1.png のような画像を追加してください。</p>'}
    <details class="upload-section">
      <summary>キャラ・服を追加</summary>
      <div class="upload-grid">
        ${['character', 'clothes'].map((type) => `
          <form class="upload-form" data-type="${type}">
            <h3>${type === 'character' ? 'キャラ画像' : '服画像'}</h3>
            <label for="${type}-id">ID</label>
            <input id="${type}-id" name="id" type="text" required pattern="[A-Za-z0-9_-]+" maxlength="80" placeholder="${type === 'character' ? 'chara1' : 'd1'}" />
            <label for="${type}-image">画像</label>
            <input id="${type}-image" name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required />
            <p class="hint">PNG / JPEG / WebP / GIF、8 MB以下</p>
            <button type="submit">追加</button>
            <span class="upload-status" role="status"></span>
          </form>`).join('')}
      </div>
    </details>
    <details class="catalog-clothes">
      <summary>登録済みの服を一覧表示</summary>
      ${state.catalog.clothes.length ? `<div class="grid small">${state.catalog.clothes.map((d) => `
        <div class="card small"><img src="${d.url}" alt="${esc(d.name)}" loading="lazy" /><div class="meta"><strong>${esc(d.name)}</strong></div></div>`).join('')}</div>` : '<p class="empty">store/clothes/ に服の画像を追加してください。</p>'}
    </details>`;

  app.querySelectorAll('.upload-form').forEach((form) => {
    const idInput = form.querySelector('[name="id"]');
    const fileInput = form.querySelector('[name="image"]');
    idInput.addEventListener('input', () => { idInput.dataset.edited = 'true'; });
    fileInput.addEventListener('change', () => {
      if (!idInput.dataset.edited && fileInput.files[0]) {
        idInput.value = fileInput.files[0].name.replace(/\.[^.]+$/, '');
      }
    });
    form.addEventListener('submit', uploadImage);
  });
}

function renderCharacterView() {
  app.className = 'character-page';
  const char = findCharacter(state.currentCharacter);
  if (!char) { app.innerHTML = '<p class="error">キャラが見つかりません。</p>'; return; }
  const dressScrollLeft = app.dataset.character === char.id
    ? app.querySelector('.dress-grid')?.scrollLeft || 0
    : 0;
  app.dataset.character = char.id;

  const sel = state.selectedDress;
  const versions = sel ? generatedVersions(char, sel) : [];
  const selected = sel ? selectedVersion(char, sel) : null;
  const selUrl = selected?.url || null;
  const displaySrc = selUrl || char.iconUrl;
  const missing = state.catalog.clothes.filter((d) => !generatedVersions(char, d.id).length);
  const stageImages = document.querySelectorAll('#stage img');
  const previousSrc = stageImages.length
    ? stageImages[stageImages.length - 1].getAttribute('src')
    : null;
  const stageSrc = previousSrc || displaySrc;
  const dressPromptSettings = sel ? promptSettingsForDress(sel) : { source: 'shared' };
  const activePreset = state.promptSettings.presets.find((preset) => (
    dressPromptSettings.source === 'preset' && preset.id === dressPromptSettings.presetId
  ));

  app.innerHTML = `
    <div class="character-toolbar">
      <a href="#/">← キャラ一覧</a>
      <h2>${esc(char.name)}</h2>
    </div>

    <div class="character-layout">
      <section class="stage">
        <div id="stage" class="stage-image ${state.busy ? 'busy' : ''}">
          ${stageSrc ? `<img src="${stageSrc}" alt="${esc(char.name)}${sel ? ` — ${esc(sel)}` : ''}" />` : '<p class="empty">画像がありません</p>'}
          ${state.busy ? '<div class="spinner">生成中…</div>' : ''}
        </div>
        <p class="stage-caption">
          ${sel ? `選択中: ${esc(sel)} — ${selUrl ? `生成済み (${versions.length}件)` : '未生成（プロンプトを確認してから生成できます）'}` : '基準画像（icon）'}
        </p>
      </section>

      <section class="dresses">
        <h3>服を選ぶ</h3>
        <div class="dress-grid">
        ${state.catalog.clothes.map((d) => {
          const done = generatedVersions(char, d.id).length > 0;
          return `
            <button class="card small dress ${d.id === sel ? 'selected' : ''}" data-dress="${esc(d.id)}">
              <img src="${d.url}" alt="${esc(d.name)}" loading="lazy" />
              <div class="meta">
                <strong>${esc(d.name)}</strong>
                <span class="badge ${done ? 'done' : 'todo'}">${done ? '生成済み' : '未生成'}</span>
              </div>
            </button>`;
        }).join('')}
        </div>
      </section>
    </div>

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

  app.querySelector('.dress-grid').scrollLeft = dressScrollLeft;

  if (displaySrc && displaySrc !== stageSrc) {
    transitionStageImage(displaySrc, `${char.name}${sel ? ` — ${sel}` : ''}`);
  } else {
    state.stageImageRequest += 1;
  }

  const advancedSettings = app.querySelector('.advanced-settings');
  advancedSettings.addEventListener('toggle', () => {
    state.advancedOpen = advancedSettings.open;
  });
  app.querySelectorAll('button.dress').forEach((btn) => {
    btn.addEventListener('click', () => selectDress(btn.dataset.dress));
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

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function transitionStageImage(src, alt) {
  const request = ++state.stageImageRequest;
  const preload = new Image();
  preload.onload = () => {
    if (request !== state.stageImageRequest) return;
    const stage = document.getElementById('stage');
    if (!stage) return;

    const next = document.createElement('img');
    next.src = src;
    next.alt = alt;
    next.className = 'stage-image-overlay';
    next.addEventListener('transitionend', (event) => {
      if (event.propertyName !== 'opacity' || request !== state.stageImageRequest) return;
      stage.querySelectorAll('img:not(.stage-image-overlay)').forEach((image) => image.remove());
      next.classList.remove('stage-image-overlay');
    }, { once: true });
    stage.append(next);
    requestAnimationFrame(() => {
      if (request === state.stageImageRequest) next.classList.add('stage-image-visible');
    });
  };
  preload.onerror = () => {
    if (request === state.stageImageRequest) {
      setStatus('画像を読み込めませんでした');
    }
  };
  preload.src = src;
}

async function selectDress(dressId) {
  if (dressId !== state.selectedDress && !await confirmPromptSaveBeforeLeaving()) {
    renderCharacterView();
    return;
  }
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
      }),
    });
    if (!generatedVersions(char, dressId).some((version) => version.url === res.url)) {
      char.generated[dressId] = [
        { url: res.url, createdAt: res.createdAt },
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
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
    reader.readAsDataURL(file);
  });
}

async function uploadImage(event) {
  event.preventDefault();
  if (state.uploading) return;

  const form = event.currentTarget;
  const id = form.elements.id.value.trim();
  const file = form.elements.image.files[0];
  const status = form.querySelector('.upload-status');
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    status.textContent = '画像は8 MB以下にしてください';
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  state.uploading = true;
  button.disabled = true;
  status.textContent = '追加中…';
  try {
    const image = await readImageAsDataUrl(file);
    await api('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: form.dataset.type, id, image }),
    });
    await refreshCatalog();
    route();
  } catch (error) {
    status.textContent = `追加失敗: ${error.message}`;
  } finally {
    state.uploading = false;
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
