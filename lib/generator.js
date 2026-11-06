import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = {
  useMock: process.env.GENERATOR === 'mock',
  mockDelayMs: 1200,
  comfyui: {
    url: (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    workflowJson: process.env.COMFYUI_WORKFLOW || path.join(ROOT, 'image_flux2_klein_image_edit_9b_distilled.json'),
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS || 10 * 60 * 1000),
  },
};

let objectInfoPromise;

/**
 * @param {object} job
 * @param {string} job.characterId
 * @param {string} job.dressId
 * @param {string} job.characterFile
 * @param {string} job.dressFile
 * @param {string} job.outDir
 * @param {string} [job.outputStem]
 * @param {string} [job.prompt]
 * @param {boolean} [job.force]
 * @returns {Promise<{file: string, mock: boolean}>}
 */
export async function generateImage(job) {
  if (CONFIG.useMock) return mockGenerate(job);
  return comfyuiGenerate(job);
}

export function getDefaultPrompt() {
  const workflow = readWorkflow();
  const parent = getWorkflowSubgraph(workflow);
  return parent.widgets_values_named?.text
    ?? parent.widgets_values?.[3]
    ?? '';
}

export function getDefaultSeed() {
  const workflow = readWorkflow();
  const parent = getWorkflowSubgraph(workflow);
  const graph = workflow.definitions.subgraphs.find((item) => item.id === parent.type);
  const randomNoise = graph?.nodes.find((node) => node.type === 'RandomNoise');
  const seed = randomNoise?.widgets_values_named?.noise_seed
    ?? parent.widgets_values_named?.noise_seed;
  return Number.isSafeInteger(seed) && seed >= 0 ? seed : null;
}

function readWorkflow() {
  return JSON.parse(fs.readFileSync(CONFIG.comfyui.workflowJson, 'utf8'));
}

function getWorkflowSubgraph(workflow) {
  const subgraphs = workflow.definitions?.subgraphs ?? [];
  const graphNode = workflow.nodes?.find((node) =>
    subgraphs.some((graph) => graph.id === node.type));
  if (!graphNode) throw new Error('Workflow JSON にサブグラフノードが見つかりません');
  return graphNode;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

async function mockGenerate(job) {
  await sleep(CONFIG.mockDelayMs);

  const file = `${job.outputStem ?? job.dressId}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768" viewBox="0 0 512 768">
  <rect width="512" height="768" fill="#eef2f7"/>
  <rect x="24" y="24" width="464" height="720" rx="12" fill="#ffffff" stroke="#c4ccd6" stroke-width="2"/>
  <text x="256" y="120" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#334155">MOCK (生成プレースホルダー)</text>
  <text x="256" y="260" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#334155">character: ${esc(job.characterId)}</text>
  <text x="256" y="320" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#334155">dress: ${esc(job.dressId)}</text>
  <text x="256" y="430" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#64748b">ComfyUI ではなくモック生成です</text>
</svg>`;

  fs.writeFileSync(path.join(job.outDir, file), svg, 'utf8');
  return { file, mock: true };
}

async function getObjectInfo() {
  if (!objectInfoPromise) {
    objectInfoPromise = fetch(`${CONFIG.comfyui.url}/object_info`).then(async (response) => {
      if (!response.ok) {
        throw new Error(`ComfyUI object_info error (${response.status}): ${await response.text()}`);
      }
      return response.json();
    });
  }
  try {
    return await objectInfoPromise;
  } catch (error) {
    objectInfoPromise = undefined;
    throw error;
  }
}

function widgetFields(nodeInfo) {
  const fields = [];
  const schema = nodeInfo?.input ?? {};
  for (const section of ['required', 'optional']) {
    for (const [name, definition] of Object.entries(schema[section] ?? {})) {
      const options = definition[1] ?? {};
      if (options.forceInput || options.rawLink) continue;
      if (
        Array.isArray(definition[0])
        || Object.hasOwn(options, 'default')
        || options.image_upload
        || options.widget
      ) {
        fields.push(name);
      }
    }
  }
  return fields;
}

function createApiNode(node, objectInfo) {
  const info = objectInfo[node.type];
  if (!info) throw new Error(`ComfyUI にノード "${node.type}" がありません`);

  const apiNode = { class_type: node.type, inputs: {} };
  const values = node.widgets_values ?? [];
  const names = widgetFields(info);
  const namedValues = node.widgets_values_named ?? {};
  for (const section of ['required', 'optional']) {
    for (const [name, definition] of Object.entries(info.input?.[section] ?? {})) {
      const options = definition[1] ?? {};
      if (!options.forceInput && !options.rawLink && Object.hasOwn(namedValues, name)) {
        apiNode.inputs[name] = namedValues[name];
      }
    }
  }

  for (const [index, name] of names.entries()) {
    if (!Object.hasOwn(apiNode.inputs, name) && index < values.length) {
      apiNode.inputs[name] = values[index];
    }
  }
  return apiNode;
}

function apiId(prefix, id) {
  return `${prefix}${id}`;
}

function assignInput(apiNodes, nodeId, inputName, value) {
  const apiNode = apiNodes[nodeId];
  if (!apiNode) throw new Error(`Workflow 接続先ノード "${nodeId}" がありません`);
  apiNode.inputs[inputName] = value;
}

function workflowToPrompt(workflow, objectInfo, { prompt, seed, filenamePrefix }) {
  const graphNode = getWorkflowSubgraph(workflow);
  const graph = workflow.definitions.subgraphs.find((item) => item.id === graphNode.type);
  const prefix = `subgraph_${graphNode.id}_`;
  const apiNodes = {};
  const rootNodes = workflow.nodes.filter((node) =>
    node.id !== graphNode.id && node.type !== 'MarkdownNote');
  const subgraphNodes = graph.nodes;

  for (const node of rootNodes) {
    apiNodes[String(node.id)] = createApiNode(node, objectInfo);
  }
  for (const node of subgraphNodes) {
    apiNodes[apiId(prefix, node.id)] = createApiNode(node, objectInfo);
  }

  const outerLinks = new Map((workflow.links ?? []).map((link) => [link[0], link]));
  const innerLinks = new Map(graph.links.map((link) => [link.id, link]));
  const parentInputs = new Map((graphNode.inputs ?? []).map((input) => [input.name, input]));
  const parentWidgets = graphNode.widgets_values_named ?? {};
  const externalInputs = graph.inputs.map((input) => {
    const parentInput = parentInputs.get(input.name);
    if (parentInput?.link !== null && parentInput?.link !== undefined) {
      const link = outerLinks.get(parentInput.link);
      if (!link) throw new Error(`Workflow 入力 "${input.name}" の接続が見つかりません`);
      return { link: [String(link[1]), link[2]] };
    }
    if (Object.hasOwn(parentWidgets, input.name)) {
      return { value: input.name === 'text' ? prompt : parentWidgets[input.name] };
    }
    return { value: input.name === 'text' ? prompt : graphNode.widgets_values?.[graph.inputs.indexOf(input)] };
  });

  for (const link of graph.links) {
    const target = subgraphNodes.find((node) => node.id === link.target_id);
    if (!target && link.target_id !== graph.outputNode.id) {
      // The supplied workflow has incoming links to removed nodes with no outgoing links.
      if (graph.links.some((candidate) => candidate.origin_id === link.target_id)) {
        throw new Error(`Workflow references missing node "${link.target_id}"`);
      }
      continue;
    }
    const inputName = target?.inputs?.[link.target_slot]?.name;
    if (!inputName) {
      if (link.target_id === graph.outputNode.id) continue;
      throw new Error(`Workflow 入力 "${link.target_id}:${link.target_slot}" を解決できません`);
    }

    if (link.origin_id === graph.inputNode.id) {
      const external = externalInputs[link.origin_slot];
      assignInput(apiNodes, apiId(prefix, target.id), inputName,
        external.link ?? external.value);
    } else {
      if (!subgraphNodes.some((node) => node.id === link.origin_id)) {
        throw new Error(`Workflow references missing node "${link.origin_id}"`);
      }
      assignInput(apiNodes, apiId(prefix, target.id), inputName,
        [apiId(prefix, link.origin_id), link.origin_slot]);
    }
  }

  for (const link of workflow.links ?? []) {
    const [, originId, originSlot, targetId, targetSlot] = link;
    if (String(originId) === String(graphNode.id)) {
      const output = graph.outputs[originSlot];
      const internalLink = innerLinks.get(output?.linkIds?.[0]);
      if (!internalLink) throw new Error(`Workflow 出力 "${originSlot}" の接続が見つかりません`);
      const target = workflow.nodes.find((node) => String(node.id) === String(targetId));
      const inputName = target?.inputs?.[targetSlot]?.name;
      if (!inputName) throw new Error(`Workflow 出力先 "${targetId}:${targetSlot}" を解決できません`);
      assignInput(apiNodes, String(targetId), inputName,
        [apiId(prefix, internalLink.origin_id), internalLink.origin_slot]);
    } else if (String(targetId) !== String(graphNode.id)) {
      const target = workflow.nodes.find((node) => String(node.id) === String(targetId));
      const inputName = target?.inputs?.[targetSlot]?.name;
      if (target && inputName) {
        assignInput(apiNodes, String(targetId), inputName, [String(originId), originSlot]);
      }
    }
  }

  if (seed !== undefined) {
    for (const node of Object.values(apiNodes)) {
      if (Object.hasOwn(node.inputs, 'noise_seed')) node.inputs.noise_seed = seed;
    }
  }

  const imageInput = graphNode.inputs.find((input) => input.name === 'image');
  const dressInput = graphNode.inputs.find((input) => input.name === 'image_1');
  const imageNodeIds = [imageInput, dressInput].map((input) => {
    const link = outerLinks.get(input?.link);
    if (!link) throw new Error(`Workflow の "${input?.name}" 画像入力が接続されていません`);
    const sourceNode = workflow.nodes.find((node) => String(node.id) === String(link[1]));
    if (sourceNode?.type !== 'LoadImage') {
      throw new Error(`Workflow の "${input.name}" は LoadImage ノードに接続してください`);
    }
    return String(sourceNode.id);
  });

  const saveNodes = Object.entries(apiNodes).filter(([, node]) => node.class_type === 'SaveImage');
  if (!saveNodes.length) throw new Error('Workflow JSON に SaveImage ノードがありません');
  for (const [, node] of saveNodes) node.inputs.filename_prefix = filenamePrefix;

  return { prompt: apiNodes, imageNodeIds, saveNodeIds: saveNodes.map(([id]) => id) };
}

function mimeType(filename) {
  return ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  })[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

async function uploadImage(filename, id) {
  const remoteName = `kisekae3-${id}-${path.basename(filename)}`;
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(filename)], { type: mimeType(filename) }), remoteName);
  form.append('type', 'input');
  form.append('overwrite', 'true');

  const response = await fetch(`${CONFIG.comfyui.url}/upload/image`, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`ComfyUI image upload error (${response.status}): ${await response.text()}`);
  }
  const result = await response.json();
  if (!result.name) throw new Error('ComfyUI image upload response did not contain a filename');
  return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

async function readJson(url, label, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${label} (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function waitForHistory(promptId) {
  const deadline = Date.now() + CONFIG.comfyui.timeoutMs;
  while (Date.now() < deadline) {
    const history = await readJson(
      `${CONFIG.comfyui.url}/history/${encodeURIComponent(promptId)}`,
      'ComfyUI history error',
    );
    const entry = history[promptId];
    if (entry?.status?.status_str === 'error') {
      throw new Error(`ComfyUI execution failed: ${JSON.stringify(entry.status.messages ?? [])}`);
    }
    if (entry?.outputs && Object.keys(entry.outputs).length) return entry;
    await sleep(1000);
  }
  throw new Error(`ComfyUI generation timed out after ${CONFIG.comfyui.timeoutMs}ms`);
}

async function comfyuiGenerate(job) {
  const workflow = readWorkflow();
  const objectInfo = await getObjectInfo();
  const converted = workflowToPrompt(workflow, objectInfo, {
    prompt: job.prompt ?? getDefaultPrompt(),
    seed: job.seed,
    filenamePrefix: `kisekae3-${job.characterId}-${job.outputStem ?? job.dressId}`,
  });

  const [characterImage, dressImage] = await Promise.all([
    uploadImage(job.characterFile, `${job.characterId}-character`),
    uploadImage(job.dressFile, `${job.characterId}-${job.dressId}-dress`),
  ]);
  converted.prompt[converted.imageNodeIds[0]].inputs.image = characterImage;
  converted.prompt[converted.imageNodeIds[1]].inputs.image = dressImage;

  const queued = await readJson(`${CONFIG.comfyui.url}/prompt`, 'ComfyUI queue error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: converted.prompt }),
  });
  if (!queued.prompt_id) {
    throw new Error(`ComfyUI did not return a prompt_id: ${JSON.stringify(queued)}`);
  }

  const history = await waitForHistory(queued.prompt_id);
  const saved = converted.saveNodeIds
    .map((id) => history.outputs[id]?.images?.[0])
    .find(Boolean);
  if (!saved) throw new Error('ComfyUI finished without a SaveImage output');

  const imageUrl = new URL(`${CONFIG.comfyui.url}/view`);
  imageUrl.searchParams.set('filename', saved.filename);
  imageUrl.searchParams.set('subfolder', saved.subfolder ?? '');
  imageUrl.searchParams.set('type', saved.type ?? 'output');
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`ComfyUI image download error (${response.status}): ${await response.text()}`);
  }

  const file = `${job.outputStem ?? job.dressId}.png`;
  fs.writeFileSync(path.join(job.outDir, file), Buffer.from(await response.arrayBuffer()));
  return { file, mock: false };
}
