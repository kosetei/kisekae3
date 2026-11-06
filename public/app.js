const app = document.getElementById('app');
const state = {
  catalog: null,
  currentCharacter: null, // char id when on character view
  selectedDress: null,    // dress id on character view
  selectedGenerated: {},  // selected generated image URL per dress
  busy: false,
  prompt: '',
  seed: 0,
  status: '',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
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
  const cards = state.catalog.characters.map((c) => `
    <a class="card" href="#/char/${esc(c.id)}">
      ${c.iconUrl ? `<img src="${c.iconUrl}" alt="${esc(c.name)}" loading="lazy" />` : '<div class="noimg">No icon</div>'}
      <div class="meta">
        <strong>${esc(c.name)}</strong>
        <span class="count">${generatedCount(c)} / ${state.catalog.clothes.length} 生成済み</span>
      </div>
    </a>`).join('');

  app.innerHTML = `
    <h2>キャラ一覧</h2>
    ${state.catalog.characters.length ? `<div class="grid">${cards}</div>` : '<p class="empty">store/characters/ にキャラフォルダを追加してください（icon.* を含む）。</p>'}
    <h2>服（clothes）</h2>
    ${state.catalog.clothes.length ? `<div class="grid small">${state.catalog.clothes.map((d) => `
      <div class="card small"><img src="${d.url}" alt="${esc(d.name)}" loading="lazy" /><div class="meta"><strong>${esc(d.name)}</strong></div></div>`).join('')}</div>` : '<p class="empty">store/clothes/ に服の画像を追加してください。</p>'}`;
}

function renderCharacterView() {
  const char = findCharacter(state.currentCharacter);
  if (!char) { app.innerHTML = '<p class="error">キャラが見つかりません。</p>'; return; }

  const sel = state.selectedDress;
  const versions = sel ? generatedVersions(char, sel) : [];
  const selected = sel ? selectedVersion(char, sel) : null;
  const selUrl = selected?.url || null;
  const displaySrc = selUrl || char.iconUrl;
  const missing = state.catalog.clothes.filter((d) => !generatedVersions(char, d.id).length);

  app.innerHTML = `
    <p><a href="#/">← キャラ一覧</a></p>
    <h2>${esc(char.name)}</h2>

    <section class="stage">
      <div id="stage" class="stage-image ${state.busy ? 'busy' : ''}">
        ${displaySrc ? `<img src="${displaySrc}" alt="" />` : '<p class="empty">画像がありません</p>'}
        ${state.busy ? '<div class="spinner">生成中…</div>' : ''}
      </div>
      <p class="stage-caption">
        ${sel ? `選択中: ${esc(sel)} — ${selUrl ? `生成済み (${versions.length}件)` : '未生成（選択すると生成されます）'}` : '基準画像（icon）'}
      </p>
      ${versions.length > 1 ? `
        <label for="generated-version">表示する生成画像</label>
        <select id="generated-version">
          ${versions.map((version, index) => `
            <option value="${esc(version.url)}" ${version.url === selected.url ? 'selected' : ''}>
              ${esc(versionLabel(version, index))}
            </option>`).join('')}
        </select>` : ''}
      <p>
        <button id="generate-all" ${missing.length ? '' : 'disabled'}>未生成を一括生成 (${missing.length})</button>
        <button id="regenerate-selected" ${sel && versions.length ? '' : 'disabled'}>選択中を再生成</button>
        <span id="status">${esc(state.status)}</span>
      </p>
    </section>

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
      <p class="hint">未生成の服を選ぶと、このプロンプトで生成します。「選択中を再生成」すると、既存画像を残したまま新しい画像を追加します。</p>
    </section>

    <section class="dresses">
      <h3>服を選ぶ</h3>
      <div class="grid small">
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
    </section>`;

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
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function selectDress(dressId) {
  state.selectedDress = dressId;
  const char = findCharacter(state.currentCharacter);
  if (generatedVersions(char, dressId).length) {
    renderCharacterView();
    return;
  }
  await generate(char, dressId);
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

// ---------------------------------------------------------------------------
// routing + refresh (files added to store/ show up on next catalog fetch)
// ---------------------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#\/char\/([A-Za-z0-9_-]+)/);
  state.currentCharacter = m ? m[1] : null;
  if (state.currentCharacter) renderCharacterView();
  else renderCharacterList();
}

window.addEventListener('hashchange', route);

(async function init() {
  await refreshCatalog();
  const config = await api('/api/config');
  state.prompt = config.prompt;
  state.seed = config.seed ?? 0;
  route();
  // poll the catalog so images added manually to store/ appear without restart
  setInterval(async () => {
    if (state.busy) return;
    await refreshCatalog();
    route();
  }, 4000);
})();
