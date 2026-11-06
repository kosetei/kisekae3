import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateImage, getDefaultPrompt, getDefaultSeed } from './lib/generator.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORE_DIR = path.join(ROOT, 'store');
const PORT = Number(process.env.PORT || 3000);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Catalog: everything is driven by the filesystem, so files added later show up
// as candidates without any manual registration.
// ---------------------------------------------------------------------------

function extOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

function isImage(name) {
  return IMAGE_EXTS.has(extOf(name));
}

function naturalSort(a, b) {
  return a.localeCompare(b, 'ja', { numeric: true });
}

function generatedFiles(generatedDir, dressId) {
  if (!fs.existsSync(generatedDir)) return [];
  return fs.readdirSync(generatedDir)
    .filter((f) => {
      if (!isImage(f) || !fs.statSync(path.join(generatedDir, f)).isFile()) return false;
      const base = path.basename(f, path.extname(f));
      return base === dressId || base.startsWith(`${dressId}__`);
    })
    .map((file) => ({
      file,
      createdAt: fs.statSync(path.join(generatedDir, file)).mtime.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function scanCatalog() {
  const clothesDir = path.join(STORE_DIR, 'clothes');
  const charactersDir = path.join(STORE_DIR, 'characters');
  const generatedDir = path.join(STORE_DIR, 'generated');

  const clothes = [];
  if (fs.existsSync(clothesDir)) {
    for (const f of fs.readdirSync(clothesDir)) {
      if (!fs.statSync(path.join(clothesDir, f)).isFile() || !isImage(f)) continue;
      const id = path.basename(f, path.extname(f));
      clothes.push({ id, name: id, url: `/store/clothes/${encodeURIComponent(f)}` });
    }
  }
  clothes.sort((a, b) => naturalSort(a.id, b.id));

  const characters = [];
  if (fs.existsSync(charactersDir)) {
    for (const entry of fs.readdirSync(charactersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const files = fs.readdirSync(path.join(charactersDir, id)).filter(isImage);
      const icon = files.find((f) => f.toLowerCase().startsWith('icon.')) ?? files[0] ?? null;

      const gdir = path.join(generatedDir, id);
      const generated = {};
      for (const dress of clothes) {
        generated[dress.id] = generatedFiles(gdir, dress.id).map(({ file, createdAt }) => ({
          url: `/store/generated/${id}/${encodeURIComponent(file)}`,
          createdAt,
        }));
      }

      characters.push({
        id,
        name: id,
        iconUrl: icon ? `/store/characters/${id}/${encodeURIComponent(icon)}` : null,
        generated,
      });
    }
  }
  characters.sort((a, b) => naturalSort(a.id, b.id));

  return { clothes, characters };
}

// ---------------------------------------------------------------------------
// Generate endpoint: existing file -> serve it; force -> save a new version.
// ---------------------------------------------------------------------------

async function handleGenerate(res, body) {
  const { character, dress, prompt, seed, force } = body ?? {};
  if (!SAFE_ID.test(character ?? '') || !SAFE_ID.test(dress ?? '')) {
    return json(res, 400, { error: 'character/dress id must be alphanumeric' });
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 10000)) {
    return json(res, 400, { error: 'prompt must be a string of 10000 characters or fewer' });
  }
  if (force !== undefined && typeof force !== 'boolean') {
    return json(res, 400, { error: 'force must be a boolean' });
  }
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
    return json(res, 400, { error: 'seed must be a non-negative safe integer' });
  }

  const characterDir = path.join(STORE_DIR, 'characters', character);
  const clothesDir = path.join(STORE_DIR, 'clothes');
  const generatedDir = path.join(STORE_DIR, 'generated', character);
  if (!fs.existsSync(characterDir)) return json(res, 404, { error: `character not found: ${character}` });

  const dressFile = fs.readdirSync(clothesDir).find((f) => isImage(f) && path.basename(f, path.extname(f)) === dress);
  if (!dressFile) return json(res, 404, { error: `dress not found: ${dress}` });

  const existing = !force ? generatedFiles(generatedDir, dress)[0] : null;
  if (existing) {
    return json(res, 200, {
      status: 'existing',
      url: `/store/generated/${character}/${encodeURIComponent(existing.file)}`,
      createdAt: existing.createdAt,
    });
  }

  fs.mkdirSync(generatedDir, { recursive: true });
  const characterFiles = fs.readdirSync(characterDir).filter(isImage);
  const characterFile = characterFiles.find((f) => f.toLowerCase().startsWith('icon.')) ?? characterFiles[0];
  if (!characterFile) return json(res, 404, { error: `character image not found: ${character}` });

  const result = await generateImage({
    characterDir,
    characterFile: path.join(characterDir, characterFile),
    dressFile: path.join(clothesDir, dressFile),
    outDir: generatedDir,
    characterId: character,
    dressId: dress,
    outputStem: `${dress}__${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    prompt,
    seed,
    force,
  });

  const createdAt = fs.statSync(path.join(generatedDir, result.file)).mtime.toISOString();
  return json(res, 200, {
    status: 'generated',
    mock: Boolean(result.mock),
    url: `/store/generated/${character}/${encodeURIComponent(result.file)}`,
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

function serveFile(res, baseDir, urlPath) {
  const target = path.resolve(baseDir, '.' + urlPath);
  if (!target.startsWith(path.resolve(baseDir))) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/catalog' && req.method === 'GET') {
      return json(res, 200, scanCatalog());
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { prompt: getDefaultPrompt(), seed: getDefaultSeed() });
    }
    if (pathname === '/api/generate' && req.method === 'POST') {
      return await handleGenerate(res, await readBody(req));
    }
    if (pathname.startsWith('/store/')) {
      return serveFile(res, STORE_DIR, pathname.slice('/store'.length));
    }
    if (pathname === '/') {
      return serveFile(res, PUBLIC_DIR, '/index.html');
    }
    return serveFile(res, PUBLIC_DIR, pathname);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`kisekae3 network: http://${address.address}:${PORT}`);
      }
    }
  }
  console.log(`kisekae3 server: http://localhost:${PORT}`);
});
