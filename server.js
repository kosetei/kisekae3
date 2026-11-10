import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkServerStatus, generateImage, sendWakeOnLan, getDefaultPrompt, getDefaultSeed } from './lib/generator.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORE_DIR = path.join(ROOT, 'store');
const PROMPT_SETTINGS_FILE = path.join(STORE_DIR, 'prompt-settings.json');
const GENERATED_PREFERENCES_FILE = path.join(STORE_DIR, 'generated-preferences.json');
const GENERATED_METADATA_FILE = path.join(STORE_DIR, 'generated-metadata.json');
const CATALOG_METADATA_FILE = path.join(STORE_DIR, 'catalog-metadata.json');
const CLOTHES_DIR = path.join(STORE_DIR, 'clothes');
const CHARACTERS_DIR = path.join(STORE_DIR, 'characters');
const GENERATED_DIR = path.join(STORE_DIR, 'generated');
const PORT = Number(process.env.PORT || 3000);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic', 'heif']);
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
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const RESERVED_CATALOG_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const UPLOAD_TYPES = new Map([
  ['image/png', { ext: 'png', matches: (data) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/jpeg', { ext: 'jpg', matches: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff }],
  ['image/webp', { ext: 'webp', matches: (data) => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' }],
  ['image/gif', { ext: 'gif', matches: (data) => ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) }],
  ['image/heic', { ext: 'heic', matches: matchesHeif }],
  ['image/heif', { ext: 'heif', matches: matchesHeif }],
]);

function matchesHeif(data) {
  if (data.length < 16 || data.toString('ascii', 4, 8) !== 'ftyp') return false;
  const boxSize = data.readUInt32BE(0);
  if (boxSize !== 0 && (boxSize < 16 || boxSize > data.length)) return false;
  const brands = data.toString('ascii', 8, Math.min(data.length, boxSize || data.length));
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].some((brand) => brands.includes(brand));
}

// ---------------------------------------------------------------------------
// Catalog: everything is driven by the filesystem, so files added later show up
// as candidates without any manual registration.
//
// Cost shape: one directory read per folder and one stat per file we report, so
// a scan scales with the number of files rather than with characters x outfits.
// The result is cached against directory mtimes, so a reload costs a handful of
// stats instead of thousands. Additions made directly on the drive are still
// picked up, because adding or removing a file changes the parent directory's
// mtime. A file overwritten under the same name is the one case the cache does
// not notice until that directory changes, so the write paths invalidate too.
// ---------------------------------------------------------------------------

function extOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

function isImage(name) {
  return IMAGE_EXTS.has(extOf(name));
}

const COLLATOR = new Intl.Collator('ja', { numeric: true });
const CATALOG_CACHE = { key: null, value: null };

function readEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

// Dirents already carry the entry type, so a regular file needs no stat.
// Symlinks keep the old behaviour of following the link.
function isReportableFile(dir, entry) {
  if (entry.isFile()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(path.join(dir, entry.name)).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

function invalidateCatalogCache() {
  CATALOG_CACHE.key = null;
}

// Cheap change signal: mtimeMs of every folder plus the metadata files.
function catalogFingerprint() {
  const parts = [];
  const stamp = (target) => {
    try {
      parts.push(`${target}=${fs.statSync(target).mtimeMs}`);
    } catch {
      parts.push(`${target}=missing`);
    }
  };
  for (const file of [CLOTHES_DIR, CHARACTERS_DIR, GENERATED_DIR,
    PROMPT_SETTINGS_FILE, GENERATED_PREFERENCES_FILE, GENERATED_METADATA_FILE, CATALOG_METADATA_FILE]) {
    stamp(file);
  }
  for (const parent of [CHARACTERS_DIR, GENERATED_DIR]) {
    for (const entry of readEntries(parent) ?? []) {
      if (entry.isDirectory()) stamp(path.join(parent, entry.name));
    }
  }
  return parts.join('|');
}

function isCatalogItemId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 255
    && id !== '.'
    && id !== '..'
    && !RESERVED_CATALOG_IDS.has(id)
    && !/[\\/\0-\x1f\x7f]/.test(id);
}

function naturalSort(a, b) {
  return COLLATOR.compare(a, b);
}

function findCharacterImage(charactersDir, id, topEntries = null) {
  const entries = topEntries ?? readEntries(charactersDir);
  const directImage = (entries ?? [])
    .filter((entry) => isReportableFile(charactersDir, entry)
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
  const inner = readEntries(characterDir);
  if (!inner) return null; // missing, or not a directory
  const files = inner
    .filter((entry) => isReportableFile(characterDir, entry) && isImage(entry.name))
    .map((entry) => entry.name);
  const icon = files.find((f) => f.toLowerCase().startsWith('icon.')) ?? files[0] ?? null;
  if (!icon) return null;

  return {
    filePath: path.join(characterDir, icon),
    url: `/store/characters/${encodeURIComponent(id)}/${encodeURIComponent(icon)}`,
  };
}

// One directory read per character folder. Generated filenames carry the outfit
// id before the "__" separator, so the lookup below is a map hit rather than a
// second pass over the folder.
function generatedIndex(generatedDir) {
  const byVariant = new Map();
  for (const entry of readEntries(generatedDir) ?? []) {
    if (!isImage(entry.name) || !isReportableFile(generatedDir, entry)) continue;
    const base = path.basename(entry.name, path.extname(entry.name));
    const variantId = base.split('__')[0] || base;
    if (!byVariant.has(variantId)) byVariant.set(variantId, []);
    byVariant.get(variantId).push({
      file: entry.name,
      createdAt: fs.statSync(path.join(generatedDir, entry.name)).mtime.toISOString(),
    });
  }
  return byVariant;
}

function generatedFiles(generatedDir, dressId) {
  return (generatedIndex(generatedDir).get(dressId) ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readGeneratedPreferences() {
  if (!fs.existsSync(GENERATED_PREFERENCES_FILE)) return {};
  const preferences = JSON.parse(fs.readFileSync(GENERATED_PREFERENCES_FILE, 'utf8'));
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('Invalid generated image preferences');
  }
  for (const [characterId, clothes] of Object.entries(preferences)) {
    if (!SAFE_ID.test(characterId) || !clothes || typeof clothes !== 'object' || Array.isArray(clothes)) {
      throw new Error('Invalid generated image preferences');
    }
    for (const [dressId, file] of Object.entries(clothes)) {
      if (!SAFE_ID.test(dressId) || typeof file !== 'string' || path.basename(file) !== file
        || !isImage(file)) {
        throw new Error('Invalid generated image preferences');
      }
    }
  }
  return preferences;
}

function writeGeneratedPreferences(preferences) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const temporaryFile = `${GENERATED_PREFERENCES_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(preferences, null, 2), 'utf8');
    fs.renameSync(temporaryFile, GENERATED_PREFERENCES_FILE);
    invalidateCatalogCache();
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

function validateGeneratedMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid generated image metadata');
  }
  const metadata = {};
  for (const [characterId, clothes] of Object.entries(value)) {
    if (!SAFE_ID.test(characterId) || !clothes || typeof clothes !== 'object' || Array.isArray(clothes)) {
      throw new Error('Invalid generated image metadata');
    }
    metadata[characterId] = {};
    for (const [dressId, images] of Object.entries(clothes)) {
      if (!SAFE_ID.test(dressId) || !images || typeof images !== 'object' || Array.isArray(images)) {
        throw new Error('Invalid generated image metadata');
      }
      metadata[characterId][dressId] = {};
      for (const [file, settings] of Object.entries(images)) {
        const hasPromptParts = settings?.characterPrompt !== undefined || settings?.dressPrompt !== undefined;
        if (path.basename(file) !== file || !isImage(file)
          || !settings || typeof settings !== 'object' || Array.isArray(settings)
          || typeof settings.prompt !== 'string' || settings.prompt.length > 10000
          || (hasPromptParts && (
            typeof settings.characterPrompt !== 'string' || settings.characterPrompt.length > 10000
            || typeof settings.dressPrompt !== 'string' || settings.dressPrompt.length > 10000
          ))
          || !(settings.seed === null || (Number.isSafeInteger(settings.seed) && settings.seed >= 0))
          || !(settings.disableLora === undefined || settings.disableLora === null
            || typeof settings.disableLora === 'boolean')) {
          throw new Error('Invalid generated image metadata');
        }
        metadata[characterId][dressId][file] = {
          prompt: settings.prompt,
          ...(hasPromptParts ? {
            characterPrompt: settings.characterPrompt,
            dressPrompt: settings.dressPrompt,
          } : {}),
          seed: settings.seed,
          disableLora: settings.disableLora ?? null,
        };
      }
    }
  }
  return metadata;
}

function readGeneratedMetadata() {
  if (!fs.existsSync(GENERATED_METADATA_FILE)) return {};
  return validateGeneratedMetadata(JSON.parse(fs.readFileSync(GENERATED_METADATA_FILE, 'utf8')));
}

function writeGeneratedMetadata(metadata) {
  const validated = validateGeneratedMetadata(metadata);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const temporaryFile = `${GENERATED_METADATA_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(validated, null, 2), 'utf8');
    fs.renameSync(temporaryFile, GENERATED_METADATA_FILE);
    invalidateCatalogCache();
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

function readCatalogMetadata() {
  if (!fs.existsSync(CATALOG_METADATA_FILE)) {
    return { characters: {}, clothes: {}, characterGroups: [], clothesGroups: [] };
  }
  const metadata = JSON.parse(fs.readFileSync(CATALOG_METADATA_FILE, 'utf8'));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid catalog metadata');
  }
  for (const type of ['characters', 'clothes']) {
    const items = metadata[type] ?? {};
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('Invalid catalog metadata');
    }
    for (const [id, item] of Object.entries(items)) {
      if (!isCatalogItemId(id) || !item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.alias !== 'string' || typeof item.group !== 'string'
        || item.alias.length > 100 || item.group.length > 100
        || (item.variantOf !== undefined && !isCatalogItemId(item.variantOf))) {
        throw new Error('Invalid catalog metadata');
      }
    }
  }
  for (const type of ['characterGroups', 'clothesGroups']) {
    const groups = metadata[type] ?? [];
    if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string'
      || !group.trim() || group.length > 100)) {
      throw new Error('Invalid catalog metadata');
    }
  }
  return {
    characters: metadata.characters ?? {},
    clothes: metadata.clothes ?? {},
    characterGroups: metadata.characterGroups ?? [],
    clothesGroups: metadata.clothesGroups ?? [],
  };
}

function writeCatalogMetadata(metadata) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const temporaryFile = `${CATALOG_METADATA_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(metadata, null, 2), 'utf8');
    fs.renameSync(temporaryFile, CATALOG_METADATA_FILE);
    invalidateCatalogCache();
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

function scanCatalog() {
  const key = catalogFingerprint();
  if (key === CATALOG_CACHE.key) return CATALOG_CACHE.value;

  const generatedPreferences = readGeneratedPreferences();
  const metadata = readCatalogMetadata();

  const clothingImages = [];
  for (const entry of readEntries(CLOTHES_DIR) ?? []) {
    if (!isImage(entry.name) || !isReportableFile(CLOTHES_DIR, entry)) continue;
    const id = path.basename(entry.name, path.extname(entry.name));
    if (!isCatalogItemId(id)) continue;
    const item = metadata.clothes[id] ?? {};
    clothingImages.push({
      id,
      name: item.alias || id.slice(0, 100),
      group: item.group || '',
      variantOf: item.variantOf || null,
      url: `/store/clothes/${encodeURIComponent(entry.name)}`,
    });
  }
  clothingImages.sort((a, b) => naturalSort(a.id, b.id));
  const clothingById = new Map(clothingImages.map((item) => [item.id, item]));
  const clothingGroups = new Map();
  for (const image of clothingImages) {
    const declaredOutfit = image.variantOf;
    const outfitId = declaredOutfit && clothingById.has(declaredOutfit) ? declaredOutfit : image.id;
    if (!clothingGroups.has(outfitId)) clothingGroups.set(outfitId, []);
    clothingGroups.get(outfitId).push(image);
  }
  const clothes = [...clothingGroups.entries()].map(([id, variants]) => {
    const primary = variants.find((variant) => variant.id === id) || variants[0];
    const outfitVariants = variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      url: variant.url,
    }));
    return {
      ...primary,
      id: primary.id,
      variants: outfitVariants,
    };
  }).sort((a, b) => naturalSort(a.id, b.id));

  const characterEntries = readEntries(CHARACTERS_DIR) ?? [];
  const characterIds = new Set();
  for (const entry of characterEntries) {
    if (entry.isDirectory()) {
      if (isCatalogItemId(entry.name)) characterIds.add(entry.name);
    } else if (isImage(entry.name) && isReportableFile(CHARACTERS_DIR, entry)) {
      const id = path.basename(entry.name, path.extname(entry.name));
      if (SAFE_ID.test(id)) characterIds.add(id);
    }
  }

  const characters = [];
  for (const id of characterIds) {
    const characterImage = findCharacterImage(CHARACTERS_DIR, id, characterEntries);
    const index = generatedIndex(path.join(GENERATED_DIR, id));
    const generated = {};
    for (const dress of clothes) {
      const variantIds = [dress.id, ...dress.variants.map((variant) => variant.id).filter((variantId) => variantId !== dress.id)];
      const primaryFile = variantIds.map((variantId) => generatedPreferences[id]?.[variantId]).find(Boolean);
      const seen = new Map();
      for (const variantId of variantIds) {
        for (const image of index.get(variantId) ?? []) seen.set(image.file, image);
      }
      generated[dress.id] = [...seen.values()]
        .sort((a, b) => Number(b.file === primaryFile) - Number(a.file === primaryFile)
          || b.createdAt.localeCompare(a.createdAt))
        .map(({ file, createdAt }) => ({
          file,
          url: `/store/generated/${id}/${encodeURIComponent(file)}`,
          createdAt,
          primary: file === primaryFile,
        }));
    }

    const item = metadata.characters[id] ?? {};
    characters.push({
      id,
      name: item.alias || id.slice(0, 100),
      group: item.group || '',
      iconUrl: characterImage?.url ?? null,
      generated,
    });
  }
  characters.sort((a, b) => naturalSort(a.id, b.id));

  const result = {
    clothes,
    clothingImages,
    characters,
    groups: {
      characters: metadata.characterGroups,
      clothes: metadata.clothesGroups,
    },
  };
  CATALOG_CACHE.key = key;
  CATALOG_CACHE.value = result;
  return result;
}

function invalidPromptSettings(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validatePromptSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.presets)
    || !value.clothes || typeof value.clothes !== 'object' || Array.isArray(value.clothes)
    || (value.characters !== undefined && (typeof value.characters !== 'object' || Array.isArray(value.characters)))) {
    throw invalidPromptSettings('Invalid prompt settings');
  }

  const presetIds = new Set();
  const presets = value.presets.map((preset) => {
    if (!preset || typeof preset !== 'object' || typeof preset.id !== 'string' || !SAFE_ID.test(preset.id)
      || presetIds.has(preset.id) || typeof preset.name !== 'string'
      || !preset.name.trim() || preset.name.length > 100
      || typeof preset.prompt !== 'string' || preset.prompt.length > 10000
      || (preset.scope !== undefined && !['character', 'dress'].includes(preset.scope))) {
      throw invalidPromptSettings('Invalid prompt preset');
    }
    presetIds.add(preset.id);
    return { id: preset.id, name: preset.name.trim(), prompt: preset.prompt, scope: preset.scope ?? 'dress' };
  });

  function normalizePromptEntry(entries, label, scope) {
    const normalized = {};
    for (const [id, settings] of Object.entries(entries || {})) {
      if (!SAFE_ID.test(id) || !settings || typeof settings !== 'object' || Array.isArray(settings)
        || !['shared', 'default', 'saved', 'last', 'preset'].includes(settings.source ?? 'shared')) {
        throw invalidPromptSettings(`Invalid prompt settings for ${label}: ${id}`);
      }
      let source = settings.source ?? 'shared';
      if (scope === 'character' && source === 'default') source = 'shared';
      if (source === 'preset' && !presetIds.has(settings.presetId)) {
        throw invalidPromptSettings(`Unknown prompt preset for ${label}: ${id}`);
      }
      if (source === 'preset'
        && presets.find((preset) => preset.id === settings.presetId)?.scope !== scope) {
        source = 'shared';
      }
      if (settings.lastPrompt !== undefined
        && (typeof settings.lastPrompt !== 'string' || settings.lastPrompt.length > 10000)) {
        throw invalidPromptSettings(`Invalid last prompt for ${label}: ${id}`);
      }
      if (settings.savedPrompt !== undefined
        && (typeof settings.savedPrompt !== 'string' || settings.savedPrompt.length > 10000)) {
        throw invalidPromptSettings(`Invalid saved prompt for ${label}: ${id}`);
      }
      normalized[id] = {
        source,
        ...(source === 'preset' ? { presetId: settings.presetId } : {}),
        ...(settings.lastPrompt !== undefined ? { lastPrompt: settings.lastPrompt } : {}),
        ...(settings.savedPrompt !== undefined ? { savedPrompt: settings.savedPrompt } : {}),
      };
    }
    return normalized;
  }

  const clothes = normalizePromptEntry(value.clothes, 'clothes', 'dress');
  const characters = normalizePromptEntry(value.characters, 'characters', 'character');
  return { presets, clothes, characters };
}

function readPromptSettings() {
  if (!fs.existsSync(PROMPT_SETTINGS_FILE)) return { presets: [], clothes: {}, characters: {} };
  try {
    return validatePromptSettings(JSON.parse(fs.readFileSync(PROMPT_SETTINGS_FILE, 'utf8')));
  } catch (error) {
    error.statusCode = 500;
    throw error;
  }
}

function writePromptSettings(settings) {
  const validated = validatePromptSettings(settings);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const temporaryFile = `${PROMPT_SETTINGS_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(validated, null, 2), 'utf8');
    fs.renameSync(temporaryFile, PROMPT_SETTINGS_FILE);
    invalidateCatalogCache();
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
  return validated;
}

function findGeneratedImage(character, dress, file) {
  const generatedDir = path.join(STORE_DIR, 'generated', character);
  if (typeof file !== 'string' || path.basename(file) !== file) return null;
  return generatedFilesForOutfit(generatedDir, dress).find((image) => image.file === file) ?? null;
}

function generatedFilesForOutfit(generatedDir, dressId) {
  const index = generatedIndex(generatedDir);
  return [...new Map(clothingVariantIds(dressId).flatMap((variantId) => index.get(variantId) ?? [])
    .map((image) => [image.file, image])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function clothingVariantIds(dressId) {
  const metadata = readCatalogMetadata();
  const existingIds = readCatalogIds(CLOTHES_DIR);
  const rootId = metadata.clothes[dressId]?.variantOf || dressId;
  const variants = existingIds.filter((id) => (
    id === rootId || metadata.clothes[id]?.variantOf === rootId
  ));
  return variants.includes(dressId) ? [dressId, ...variants.filter((id) => id !== dressId)] : [dressId];
}

function generatedImageOwner(character, dressId, file) {
  const ids = clothingVariantIds(dressId);
  const generatedDir = path.join(STORE_DIR, 'generated', character);
  return ids.find((id) => generatedFiles(generatedDir, id).some((image) => image.file === file)) || dressId;
}

function validateGeneratedImageRequest(body) {
  const { character, dress, file } = body ?? {};
  if (!SAFE_ID.test(character ?? '') || !SAFE_ID.test(dress ?? '')) {
    return { error: 'character/dress id must be alphanumeric' };
  }
  if (typeof file !== 'string' || path.basename(file) !== file) {
    return { error: 'file must be a generated image filename' };
  }
  return { character, dress, file };
}

function handleGeneratedSelection(res, body) {
  const request = validateGeneratedImageRequest(body);
  if (request.error) return json(res, 400, { error: request.error });
  if (!findGeneratedImage(request.character, request.dress, request.file)) {
    return json(res, 404, { error: 'generated image not found' });
  }

  const preferences = readGeneratedPreferences();
  preferences[request.character] ??= {};
  const owner = generatedImageOwner(request.character, request.dress, request.file);
  preferences[request.character][owner] = request.file;
  preferences[request.character][request.dress] = request.file;
  writeGeneratedPreferences(preferences);
  return json(res, 200, { character: request.character, dress: request.dress, file: request.file });
}

function handleDeleteGeneratedImage(res, body) {
  const request = validateGeneratedImageRequest(body);
  if (request.error) return json(res, 400, { error: request.error });
  if (!findGeneratedImage(request.character, request.dress, request.file)) {
    return json(res, 404, { error: 'generated image not found' });
  }

  const preferences = readGeneratedPreferences();
  const metadata = readGeneratedMetadata();
  const owner = generatedImageOwner(request.character, request.dress, request.file);
  fs.unlinkSync(path.join(GENERATED_DIR, request.character, request.file));
  invalidateCatalogCache();
  let preferencesChanged = false;
  for (const variantId of clothingVariantIds(request.dress)) {
    if (preferences[request.character]?.[variantId] === request.file) {
      delete preferences[request.character][variantId];
      preferencesChanged = true;
    }
  }
  if (preferencesChanged) {
    if (!Object.keys(preferences[request.character]).length) delete preferences[request.character];
    writeGeneratedPreferences(preferences);
  }
  const imageMetadata = metadata[request.character]?.[owner];
  if (imageMetadata?.[request.file]) {
    delete imageMetadata[request.file];
    if (!Object.keys(imageMetadata).length) delete metadata[request.character][owner];
    if (!Object.keys(metadata[request.character]).length) delete metadata[request.character];
    writeGeneratedMetadata(metadata);
  }
  return json(res, 200, { character: request.character, dress: request.dress, file: request.file });
}

function handleGetGeneratedSettings(res, query) {
  const request = validateGeneratedImageRequest({
    character: query.get('character'),
    dress: query.get('dress'),
    file: query.get('file'),
  });
  if (request.error) return json(res, 400, { error: request.error });
  if (!findGeneratedImage(request.character, request.dress, request.file)) {
    return json(res, 404, { error: 'generated image not found' });
  }
  const metadata = readGeneratedMetadata();
  const owner = generatedImageOwner(request.character, request.dress, request.file);
  const settings = metadata[request.character]?.[request.dress]?.[request.file]
    ?? metadata[request.character]?.[owner]?.[request.file];
  return json(res, 200, settings ?? {
    prompt: null,
    characterPrompt: null,
    dressPrompt: null,
    seed: null,
    disableLora: null,
  });
}

// ---------------------------------------------------------------------------
// Generate endpoint: existing file -> serve it; force -> save a new version.
// ---------------------------------------------------------------------------

async function handleGenerate(res, body) {
  const { character, dress, dressVariant, prompt, characterPrompt, dressPrompt, seed, force, disableLora } = body ?? {};
  if (!SAFE_ID.test(character ?? '') || !SAFE_ID.test(dress ?? '')) {
    return json(res, 400, { error: 'character/dress id must be alphanumeric' });
  }
  if (dressVariant !== undefined && !SAFE_ID.test(dressVariant ?? '')) {
    return json(res, 400, { error: 'dressVariant id must be alphanumeric' });
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 10000)) {
    return json(res, 400, { error: 'prompt must be a string of 10000 characters or fewer' });
  }
  const hasPromptParts = characterPrompt !== undefined || dressPrompt !== undefined;
  if (hasPromptParts && (
    typeof characterPrompt !== 'string' || characterPrompt.length > 10000
    || typeof dressPrompt !== 'string' || dressPrompt.length > 10000
  )) {
    return json(res, 400, { error: 'characterPrompt and dressPrompt must be strings of 10000 characters or fewer' });
  }
  if (force !== undefined && typeof force !== 'boolean') {
    return json(res, 400, { error: 'force must be a boolean' });
  }
  if (disableLora !== undefined && typeof disableLora !== 'boolean') {
    return json(res, 400, { error: 'disableLora must be a boolean' });
  }
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
    return json(res, 400, { error: 'seed must be a non-negative safe integer' });
  }

  const actualPrompt = hasPromptParts
    ? [characterPrompt.trim(), dressPrompt.trim()].filter(Boolean).join('\n')
    : prompt ?? getDefaultPrompt();
  if (actualPrompt.length > 10000) {
    return json(res, 400, { error: 'combined prompt must be 10000 characters or fewer' });
  }
  const actualCharacterPrompt = hasPromptParts ? characterPrompt : '';
  const actualDressPrompt = hasPromptParts ? dressPrompt : actualPrompt;
  const charactersDir = path.join(STORE_DIR, 'characters');
  const clothesDir = path.join(STORE_DIR, 'clothes');
  const generatedDir = path.join(STORE_DIR, 'generated', character);
  if (!fs.existsSync(charactersDir)) return json(res, 404, { error: `character not found: ${character}` });
  const characterImage = findCharacterImage(charactersDir, character);
  if (!characterImage) return json(res, 404, { error: `character image not found: ${character}` });

  const selectedVariant = dressVariant ?? dress;
  if (selectedVariant !== dress && !clothingVariantIds(dress).includes(selectedVariant)) {
    return json(res, 400, { error: 'dressVariant must belong to the selected outfit' });
  }
  const dressFile = fs.readdirSync(clothesDir).find((f) => isImage(f) && path.basename(f, path.extname(f)) === selectedVariant);
  if (!dressFile) return json(res, 404, { error: `dress not found: ${dress}` });

  const versions = generatedFilesForOutfit(generatedDir, dress);
  const preferredFile = readGeneratedPreferences()[character]?.[dress];
  const existing = !force
    ? versions.find((version) => version.file === preferredFile) ?? versions[0] ?? null
    : null;
  if (existing) {
    return json(res, 200, {
      status: 'existing',
      file: existing.file,
      url: `/store/generated/${character}/${encodeURIComponent(existing.file)}`,
      createdAt: existing.createdAt,
    });
  }

  const actualSeed = seed ?? getDefaultSeed();
  fs.mkdirSync(generatedDir, { recursive: true });
  const result = await generateImage({
    characterFile: characterImage.filePath,
    dressFile: path.join(clothesDir, dressFile),
    outDir: generatedDir,
    characterId: character,
    dressId: dress,
    outputStem: `${selectedVariant}__${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    prompt: actualPrompt,
    seed: actualSeed ?? undefined,
    force,
    disableLora,
  });

  const generatedMetadata = readGeneratedMetadata();
  generatedMetadata[character] ??= {};
  generatedMetadata[character][selectedVariant] ??= {};
  generatedMetadata[character][selectedVariant][result.file] = {
    prompt: actualPrompt,
    characterPrompt: actualCharacterPrompt,
    dressPrompt: actualDressPrompt,
    seed: actualSeed,
    disableLora: disableLora ?? false,
  };
  writeGeneratedMetadata(generatedMetadata);

  const promptSettings = readPromptSettings();
  promptSettings.clothes[dress] ??= { source: 'shared' };
  promptSettings.clothes[dress].lastPrompt = actualDressPrompt;
  promptSettings.characters[character] ??= { source: 'shared' };
  promptSettings.characters[character].lastPrompt = actualCharacterPrompt;
  writePromptSettings(promptSettings);

  const createdAt = fs.statSync(path.join(generatedDir, result.file)).mtime.toISOString();
  return json(res, 200, {
    status: 'generated',
    mock: Boolean(result.mock),
    file: result.file,
    url: `/store/generated/${character}/${encodeURIComponent(result.file)}`,
    createdAt,
  });
}

// One read per folder. Callers that test many ids share the list instead of
// rescanning the folder once per id.
function readCatalogIds(dir) {
  const ids = [];
  for (const entry of readEntries(dir) ?? []) {
    if (isImage(entry.name) && isReportableFile(dir, entry)) {
      ids.push(path.basename(entry.name, path.extname(entry.name)));
    }
  }
  return ids;
}

function identifierSet(dir, includeDirectories = false) {
  const ids = new Set();
  for (const entry of readEntries(dir) ?? []) {
    if (entry.isDirectory()) {
      if (includeDirectories) ids.add(entry.name.toLowerCase());
      continue;
    }
    if (isImage(entry.name) && isReportableFile(dir, entry)) {
      ids.add(path.basename(entry.name, path.extname(entry.name)).toLowerCase());
    }
  }
  return ids;
}

function identifierExists(dir, id, includeDirectories = false) {
  return identifierSet(dir, includeDirectories).has(id.toLowerCase());
}

function nextCatalogId(type) {
  const isCharacter = type === 'character';
  const ids = identifierSet(path.join(STORE_DIR, isCharacter ? 'characters' : 'clothes'), isCharacter);
  const prefix = isCharacter ? 'chara' : 'd';
  let number = 1;
  while (ids.has(`${prefix}${number}`)) number += 1;
  return `${prefix}${number}`;
}

function handleUpload(res, body) {
  const { type, image, alias: requestedAlias } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  const dirName = type === 'character' ? 'characters' : 'clothes';
  const targetDir = path.join(STORE_DIR, dirName);
  const id = body?.id === undefined ? nextCatalogId(type) : body.id;
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    return json(res, 400, { error: 'ID must use only letters, numbers, underscores, and hyphens' });
  }
  if (requestedAlias !== undefined
    && (typeof requestedAlias !== 'string' || requestedAlias.length > 100)) {
    return json(res, 400, { error: 'alias must be a string of 100 characters or fewer' });
  }
  if (typeof image !== 'string') {
    return json(res, 400, { error: 'image data is required' });
  }

  const match = image.match(/^data:(image\/(?:png|jpeg|webp|gif|heic|heif));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return json(res, 400, { error: 'Only PNG, JPEG, WebP, GIF, HEIC, and HEIF images are supported' });

  const [, mimeType, encoded] = match;
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) {
    return json(res, 413, { error: 'Image must be 8 MB or smaller' });
  }
  const fileType = UPLOAD_TYPES.get(mimeType);
  if (!fileType.matches(data)) return json(res, 400, { error: 'Image content does not match its file type' });

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
  invalidateCatalogCache();
  if (requestedAlias?.trim()) {
    try {
      const metadata = readCatalogMetadata();
      metadata[dirName][id] = { ...metadata[dirName][id], alias: requestedAlias.trim(), group: '' };
      writeCatalogMetadata(metadata);
    } catch (error) {
      fs.unlinkSync(path.join(targetDir, file));
      throw error;
    }
  }
  return json(res, 201, { id, url: `/store/${dirName}/${encodeURIComponent(file)}` });
}

function handleCatalogItem(res, body) {
  const { type, id, alias, group } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  if (!isCatalogItemId(id)) {
    return json(res, 400, { error: 'Invalid catalog ID' });
  }
  if (typeof alias !== 'string' || alias.length > 100
    || typeof group !== 'string' || group.length > 100) {
    return json(res, 400, { error: 'alias and group must be strings of 100 characters or fewer' });
  }

  const dirName = type === 'character' ? 'characters' : 'clothes';
  if (!identifierExists(path.join(STORE_DIR, dirName), id, type === 'character')) {
    return json(res, 404, { error: `Catalog item not found: ${id}` });
  }
  const metadata = readCatalogMetadata();
  metadata[dirName][id] = { ...metadata[dirName][id], alias: alias.trim(), group: group.trim() };
  const groupsKey = type === 'character' ? 'characterGroups' : 'clothesGroups';
  if (group.trim() && !metadata[groupsKey].includes(group.trim())) {
    metadata[groupsKey].push(group.trim());
  }
  writeCatalogMetadata(metadata);
  return json(res, 200, { id, alias: alias.trim(), group: group.trim() });
}

function handleCatalogItems(res, body) {
  const { type, items, group } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  if (!Array.isArray(items) || !items.length || items.length > 500
    || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    return json(res, 400, { error: 'items must be a non-empty array of at most 500 catalog items' });
  }
  if (items.some((item) => !isCatalogItemId(item.id))) {
    return json(res, 400, { error: 'Catalog item IDs must be filenames without path separators and at most 255 characters' });
  }
  if (items.some((item) => typeof item.alias !== 'string' || item.alias.length > 100)) {
    return json(res, 400, { error: 'Each catalog item alias must be a string of 100 characters or fewer' });
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    return json(res, 400, { error: 'Catalog item IDs must be unique' });
  }
  if (typeof group !== 'string' || group.length > 100) {
    return json(res, 400, { error: 'group must be a string of 100 characters or fewer' });
  }

  const dirName = type === 'character' ? 'characters' : 'clothes';
  const existing = identifierSet(path.join(STORE_DIR, dirName), type === 'character');
  if (items.some((item) => !existing.has(item.id.toLowerCase()))) {
    return json(res, 404, { error: 'One or more catalog items were not found' });
  }

  const metadata = readCatalogMetadata();
  const groupsKey = type === 'character' ? 'characterGroups' : 'clothesGroups';
  const normalizedGroup = group.trim();
  let movedItems = 0;
  for (const { id, alias } of items) {
    const previousGroup = metadata[dirName][id]?.group || '';
    if (previousGroup !== normalizedGroup) movedItems += 1;
    metadata[dirName][id] = { ...metadata[dirName][id], alias: alias.trim(), group: normalizedGroup };
  }
  if (normalizedGroup && !metadata[groupsKey].includes(normalizedGroup)) {
    metadata[groupsKey].push(normalizedGroup);
  }
  writeCatalogMetadata(metadata);
  return json(res, 200, { movedItems, ids: items.map((item) => item.id) });
}

function handleClothingVariants(res, body) {
  const { ids, outfitId } = body ?? {};
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500
    || ids.some((id) => !isCatalogItemId(id)) || new Set(ids).size !== ids.length
    || !(outfitId === null || isCatalogItemId(outfitId))) {
    return json(res, 400, { error: 'ids must contain unique clothing IDs and outfitId must be a clothing ID or null' });
  }
  if (outfitId !== null && ids.length < 2) {
    return json(res, 400, { error: 'At least two clothing IDs are required to create variants' });
  }
  const metadata = readCatalogMetadata();
  const existingIds = readCatalogIds(CLOTHES_DIR);
  const existingLower = new Set(existingIds.map((name) => name.toLowerCase()));
  if (ids.some((id) => !existingLower.has(id.toLowerCase()))) {
    return json(res, 404, { error: 'One or more clothing images were not found' });
  }

  const selectedGroups = new Set(ids.map((id) => metadata.clothes[id]?.variantOf || id));
  const affectedIds = existingIds.filter((id) => selectedGroups.has(metadata.clothes[id]?.variantOf || id));
  if (outfitId !== null && !ids.includes(outfitId)) {
    return json(res, 400, { error: 'outfitId must be one of the selected clothing IDs' });
  }
  const normalizedOutfitId = outfitId === null ? null : outfitId;
  const outfitGroup = normalizedOutfitId ? metadata.clothes[normalizedOutfitId]?.group || '' : '';
  for (const id of affectedIds) {
    const item = metadata.clothes[id] ?? { alias: id.slice(0, 100), group: '' };
    if (normalizedOutfitId) {
      item.group = outfitGroup;
      if (id !== normalizedOutfitId) item.variantOf = normalizedOutfitId;
      else delete item.variantOf;
    } else {
      delete item.variantOf;
    }
    metadata.clothes[id] = item;
  }
  writeCatalogMetadata(metadata);
  return json(res, 200, { ids: affectedIds, outfitId: normalizedOutfitId });
}

function handleCatalogGroup(res, body) {
  const { type, group } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  if (typeof group !== 'string' || !group.trim() || group.trim().length > 100) {
    return json(res, 400, { error: 'group must be a non-empty string of 100 characters or fewer' });
  }
  const groupsKey = type === 'character' ? 'characterGroups' : 'clothesGroups';
  const normalizedGroup = group.trim();
  const metadata = readCatalogMetadata();
  if (metadata[groupsKey].some((existing) => existing.toLocaleLowerCase() === normalizedGroup.toLocaleLowerCase())) {
    return json(res, 409, { error: `Folder already exists: ${normalizedGroup}` });
  }
  metadata[groupsKey].push(normalizedGroup);
  writeCatalogMetadata(metadata);
  return json(res, 201, { group: normalizedGroup });
}

function handleRenameCatalogGroup(res, body) {
  const { type, group, newGroup } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  if (typeof group !== 'string' || !group.trim() || group.trim().length > 100
    || typeof newGroup !== 'string' || !newGroup.trim() || newGroup.trim().length > 100) {
    return json(res, 400, { error: 'group and newGroup must be non-empty strings of 100 characters or fewer' });
  }
  const groupsKey = type === 'character' ? 'characterGroups' : 'clothesGroups';
  const itemsKey = type === 'character' ? 'characters' : 'clothes';
  const oldName = group.trim();
  const normalizedName = newGroup.trim();
  const metadata = readCatalogMetadata();
  const existingName = metadata[groupsKey].find((existing) => existing === oldName);
  if (!existingName) return json(res, 404, { error: `Folder not found: ${oldName}` });
  if (metadata[groupsKey].some((existing) => existing !== existingName
    && existing.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
    return json(res, 409, { error: `Folder already exists: ${normalizedName}` });
  }

  metadata[groupsKey] = metadata[groupsKey].map((existing) => (
    existing === existingName ? normalizedName : existing
  ));
  for (const item of Object.values(metadata[itemsKey])) {
    if (item.group === existingName) item.group = normalizedName;
  }
  writeCatalogMetadata(metadata);
  return json(res, 200, { type, group: existingName, newGroup: normalizedName });
}

function handleDeleteCatalogGroup(res, body) {
  const { type, group } = body ?? {};
  if (!['character', 'clothes'].includes(type)) {
    return json(res, 400, { error: 'type must be character or clothes' });
  }
  if (typeof group !== 'string' || !group.trim() || group.trim().length > 100) {
    return json(res, 400, { error: 'group must be a non-empty string of 100 characters or fewer' });
  }
  const groupsKey = type === 'character' ? 'characterGroups' : 'clothesGroups';
  const itemsKey = type === 'character' ? 'characters' : 'clothes';
  const normalizedGroup = group.trim();
  const metadata = readCatalogMetadata();
  const storedGroup = metadata[groupsKey].find((existing) => existing === normalizedGroup);
  if (!storedGroup) return json(res, 404, { error: `Folder not found: ${normalizedGroup}` });

  let movedItems = 0;
  for (const item of Object.values(metadata[itemsKey])) {
    if (item.group === storedGroup) {
      item.group = '';
      movedItems += 1;
    }
  }
  metadata[groupsKey] = metadata[groupsKey].filter((existing) => existing !== storedGroup);
  writeCatalogMetadata(metadata);
  return json(res, 200, { group: storedGroup, movedItems });
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
    if (pathname === '/api/catalog-item' && req.method === 'PUT') {
      return handleCatalogItem(res, await readBody(req));
    }
    if (pathname === '/api/catalog-items' && req.method === 'PUT') {
      return handleCatalogItems(res, await readBody(req));
    }
    if (pathname === '/api/clothing-variants' && req.method === 'PUT') {
      return handleClothingVariants(res, await readBody(req));
    }
    if (pathname === '/api/catalog-group' && req.method === 'POST') {
      return handleCatalogGroup(res, await readBody(req));
    }
    if (pathname === '/api/catalog-group' && req.method === 'PUT') {
      return handleRenameCatalogGroup(res, await readBody(req));
    }
    if (pathname === '/api/catalog-group' && req.method === 'DELETE') {
      return handleDeleteCatalogGroup(res, await readBody(req));
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { prompt: getDefaultPrompt(), seed: getDefaultSeed() });
    }
    if (pathname === '/api/server-status' && req.method === 'GET') {
      return json(res, 200, await checkServerStatus());
    }
    if (pathname === '/api/wake' && req.method === 'POST') {
      return json(res, 200, await sendWakeOnLan());
    }
    if (pathname === '/api/prompt-settings' && req.method === 'GET') {
      return json(res, 200, readPromptSettings());
    }
    if (pathname === '/api/prompt-settings' && req.method === 'PUT') {
      return json(res, 200, writePromptSettings(await readBody(req)));
    }
    if (pathname === '/api/generate' && req.method === 'POST') {
      return await handleGenerate(res, await readBody(req));
    }
    if (pathname === '/api/generated-selection' && req.method === 'PUT') {
      return handleGeneratedSelection(res, await readBody(req));
    }
    if (pathname === '/api/generated-settings' && req.method === 'GET') {
      return handleGetGeneratedSettings(res, url.searchParams);
    }
    if (pathname === '/api/generated-image' && req.method === 'DELETE') {
      return handleDeleteGeneratedImage(res, await readBody(req));
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
