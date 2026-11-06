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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const UPLOAD_TYPES = new Map([
  ['image/png', { ext: 'png', matches: (data) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/jpeg', { ext: 'jpg', matches: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff }],
  ['image/webp', { ext: 'webp', matches: (data) => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' }],
  ['image/gif', { ext: 'gif', matches: (data) => ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) }],
]);

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

function findCharacterImage(charactersDir, id) {
  const entries = fs.readdirSync(charactersDir, { withFileTypes: true });
  const directImage = entries
    .filter((entry) => entry.isFile()
      && isImage(entry.name)
      && path.basename(entry.name, path.extname(entry.name)) === id)
    .sort((a, b) => a.name.localeCompare(b.name))[0];

  if (directImage) {
    return {
      filePath: path.join(charactersDir, directImage.name),
      url: `/store/characters/${encodeURIComponent(directImage.name)}`,
    };
  }

  const characterDir = path.join(charactersDir, id);
  if (!fs.existsSync(characterDir) || !fs.statSync(characterDir).isDirectory()) return null;
  const files = fs.readdirSync(characterDir).filter(isImage);
  const icon = files.find((f) => f.toLowerCase().startsWith('icon.')) ?? files[0] ?? null;
  if (!icon) return null;

  return {
    filePath: path.join(characterDir, icon),
    url: `/store/characters/${encodeURIComponent(id)}/${encodeURIComponent(icon)}`,
  };
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
    const characterIds = new Set();
    for (const entry of fs.readdirSync(charactersDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        characterIds.add(entry.name);
      } else if (entry.isFile() && isImage(entry.name)) {
        const id = path.basename(entry.name, path.extname(entry.name));
        if (SAFE_ID.test(id)) characterIds.add(id);
      }
    }

    for (const id of characterIds) {
      const characterImage = findCharacterImage(charactersDir, id);
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
        iconUrl: characterImage?.url ?? null,
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

  const charactersDir = path.join(STORE_DIR, 'characters');
  const clothesDir = path.join(STORE_DIR, 'clothes');
  const generatedDir = path.join(STORE_DIR, 'generated', character);
  if (!fs.existsSync(charactersDir)) return json(res, 404, { error: `character not found: ${character}` });
  const characterImage = findCharacterImage(charactersDir, character);
  if (!characterImage) return json(res, 404, { error: `character image not found: ${character}` });

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
  const result = await generateImage({
    characterFile: characterImage.filePath,
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

function identifierExists(dir, id, includeDirectories = false) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    if (includeDirectories && entry.isDirectory() && entry.name.toLowerCase() === id.toLowerCase()) return true;
    return entry.isFile()
      && isImage(entry.name)
      && path.basename(entry.name, path.extname(entry.name)).toLowerCase() === id.toLowerCase();
  });
}

function handleUpload(res, body) {
  const { type, id, image } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    return json(res, 400, { error: 'ID must use only letters, numbers, underscores, and hyphens' });
  }
  if (typeof image !== 'string') {
    return json(res, 400, { error: 'image data is required' });
  }

  const match = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return json(res, 400, { error: 'Only PNG, JPEG, WebP, and GIF images are supported' });

  const [, mimeType, encoded] = match;
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) {
    return json(res, 413, { error: 'Image must be 8 MB or smaller' });
  }
  const fileType = UPLOAD_TYPES.get(mimeType);
  if (!fileType.matches(data)) return json(res, 400, { error: 'Image content does not match its file type' });

  const dirName = type === 'character' ? 'characters' : 'clothes';
  const targetDir = path.join(STORE_DIR, dirName);
  if (identifierExists(targetDir, id, type === 'character')) {
    return json(res, 409, { error: `ID already exists: ${id}` });
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const file = `${id}.${fileType.ext}`;
  try {
    fs.writeFileSync(path.join(targetDir, file), data, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return json(res, 409, { error: `ID already exists: ${id}` });
    throw error;
  }
  return json(res, 201, { id, url: `/store/${dirName}/${encodeURIComponent(file)}` });
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
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        failed = true;
        const error = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
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
    if (pathname === '/api/upload' && req.method === 'POST') {
      return handleUpload(res, await readBody(req));
    }
    if (pathname.startsWith('/store/')) {
      return serveFile(res, STORE_DIR, pathname.slice('/store'.length));
    }
    if (pathname === '/') {
      return serveFile(res, PUBLIC_DIR, '/index.html');
    }
    return serveFile(res, PUBLIC_DIR, pathname);
  } catch (e) {
    return json(res, e.statusCode ?? 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`kisekae3 server: http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`kisekae3 network: http://${address.address}:${PORT}`);
      }
    }
  }
});
