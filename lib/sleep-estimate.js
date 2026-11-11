// PC がスリープするまでの時間の推定（表示用）。
//
// PC 側の前提（issue #12 / #10 の記録。環境変数で変えられる）:
// - Windows のスリープ: 最後の活動から PC_SLEEP_IDLE_MINUTES 分（既定 60 分。AC のスリープ設定）
// - comfy-keep-awake.ps1 (v3): ComfyUI の queue の running/pending か /history の新しい実行を「活動」とし、
//   最後の活動から KEEP_AWAKE_WINDOW_MINUTES 分（既定 5 分）スリープを止める（ES_SYSTEM_REQUIRED を保持）
// よって推定スリープ時刻 = 最後の活動 + keep-awake の保持時間 + スリープまでのアイドル時間。
// 「最後の活動」は次の中で一番新しいもの:
// - ComfyUI の /history の最新の実行（直接 ComfyUI を使った分も含む）
// - このサーバーが最後に生成を終えた時刻
// - このサーバーが ComfyUI を起動・復帰させた時刻（復帰直後からアイドル時間を数える）
// PC 上のキーボード・マウス・RDP の操作はわからないので、あくまで目安。
// 状態確認（アクセス時・画面遷移時）のときだけ ComfyUI に問い合わせ、定期的には確認しない。
import http from 'node:http';
import https from 'node:https';

const REQUEST_TIMEOUT_MS = 2000;

let lastGenerationAt = 0;

/** このサーバー経由の生成が終わったときに呼ぶ */
export function noteGenerationFinished(at = Date.now()) {
  lastGenerationAt = Math.max(lastGenerationAt, at);
}

function minutesEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function sleepEstimateConfig() {
  return {
    idleMinutes: minutesEnv('PC_SLEEP_IDLE_MINUTES', 60),
    keepAwakeWindowMinutes: minutesEnv('KEEP_AWAKE_WINDOW_MINUTES', 5),
  };
}

function getJson(baseUrl, pathname) {
  return new Promise((resolve) => {
    const target = new URL(pathname, baseUrl);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target, { timeout: REQUEST_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy(new Error('too large'));
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(null));
  });
}

/** /history の最新の実行の最後のタイムスタンプ（ms）。わからなければ 0 */
function latestHistoryTimestamp(history) {
  if (!history || typeof history !== 'object') return 0;
  let latest = 0;
  for (const entry of Object.values(history)) {
    for (const message of entry?.status?.messages || []) {
      const timestamp = Number(message?.[1]?.timestamp);
      if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
    }
  }
  return latest;
}

/**
 * @param {URL} base ComfyUI の URL
 * @param {{comfyui: boolean, mock: boolean, readyAt?: number}} status
 * @returns {Promise<null | {busy: boolean, sleepAt: string|null, remainingSec: number|null, lastActivityAt: string|null, basis: string|null}>}
 */
export async function estimateSleep(base, { comfyui, mock, readyAt = 0 }) {
  const config = sleepEstimateConfig();
  if (mock || !comfyui || config.idleMinutes <= 0) return null;
  const [queue, history] = await Promise.all([
    getJson(base, '/queue'),
    getJson(base, '/history?max_items=1'),
  ]);
  const busy = Boolean(queue && ((queue.queue_running?.length || 0) + (queue.queue_pending?.length || 0)));
  if (busy) return { busy: true, sleepAt: null, remainingSec: null, lastActivityAt: new Date().toISOString(), basis: 'queue' };
  const candidates = [
    ['comfyui_history', latestHistoryTimestamp(history)],
    ['generation', lastGenerationAt],
    ['start', readyAt],
  ].filter(([, at]) => at > 0);
  if (!candidates.length) return { busy: false, sleepAt: null, remainingSec: null, lastActivityAt: null, basis: null };
  const [basis, lastActivityAt] = candidates.reduce((a, b) => (b[1] > a[1] ? b : a));
  const sleepAtMs = lastActivityAt + (config.keepAwakeWindowMinutes + config.idleMinutes) * 60_000;
  return {
    busy: false,
    sleepAt: new Date(sleepAtMs).toISOString(),
    remainingSec: Math.round((sleepAtMs - Date.now()) / 1000),
    lastActivityAt: new Date(lastActivityAt).toISOString(),
    basis,
  };
}
