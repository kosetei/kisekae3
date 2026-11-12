// PC のスリープ状態の取得と延長（#12）。
//
// 取得は SSH で PC の comfy-sleep.ps1 -Status を実行する。延長は
// comfy-sleep.ps1 -ExtendMinutes N が要求ファイルを書いて keep_awake タスクを /Run する。
// SetThreadExecutionState はセッション依存なので、SSH (session 0) から直接は呼ばない。
//
// ガード:
// - 対象ホストは COMFYUI_URL のホストだけ。ユーザー・タスク名・スクリプトパスは環境変数の固定値だけを使う。
// - スクリプトパスはドライブ文字 + 英数字と _ . / - だけに限定する（スペースや cmd のメタ文字を拒否）。
// - 取得結果は短時間キャッシュする（状態確認のたびに SSH を起動しない）。
import { comfyuiTarget, isMockGenerator } from './generator.js';
import { runSsh } from './comfyui-launcher.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SAFE_SCRIPT = /^[A-Za-z]:\/[A-Za-z0-9_./-]+$/;
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_CACHE_MS = 5000;
const DEFAULT_MAX_EXTEND_MINUTES = 1440;

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function lastLine(result) {
  return (result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit ${result.code}`;
}

export function pcPowerConfig() {
  const { host } = comfyuiTarget();
  const user = (process.env.COMFYUI_SSH_USER || '').trim();
  const task = (process.env.COMFYUI_KEEP_AWAKE_TASK || 'keep_awake').trim();
  const script = (process.env.PC_SLEEP_SCRIPT || `C:/Users/${user}/comfy-control/comfy-sleep.ps1`).trim();
  let configError = null;
  if (!user || !SAFE_NAME.test(user)) configError = 'COMFYUI_SSH_USER が未設定か、使えない文字が含まれています';
  else if (!SAFE_HOST.test(host)) configError = `COMFYUI_URL のホスト名 ${host} はスリープ制御の対象にできません`;
  else if (!SAFE_SCRIPT.test(script)) configError = 'PC_SLEEP_SCRIPT のパスが使えません（例: C:/Users/tatei/comfy-control/comfy-sleep.ps1）';
  else if (!SAFE_NAME.test(task)) configError = 'COMFYUI_KEEP_AWAKE_TASK に使えない文字が含まれています';
  return {
    enabled: !configError && !isMockGenerator(),
    configError,
    user,
    host,
    task,
    script,
    sshBin: process.env.COMFYUI_SSH_BIN || 'ssh',
    timeoutMs: positiveInt('PC_SLEEP_SSH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    cacheMs: positiveInt('PC_SLEEP_CACHE_MS', DEFAULT_CACHE_MS),
    maxExtendMinutes: Math.min(DEFAULT_MAX_EXTEND_MINUTES, positiveInt('PC_SLEEP_MAX_EXTEND_MINUTES', DEFAULT_MAX_EXTEND_MINUTES)),
  };
}

function parseJsonOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.replace(/^\uFEFF/, '').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

let cache = { at: 0, value: null };

/** SSH で PC のスリープ状態を取得する。失敗しても例外にせず available:false を返す。 */
export async function readPcSleep({ force = false } = {}) {
  const config = pcPowerConfig();
  if (!config.enabled) {
    return { available: false, enabled: false, error: config.configError || 'スリープ制御は設定されていません' };
  }
  if (!force && cache.value && Date.now() - cache.at < config.cacheMs) return cache.value;
  const result = await runSsh(config, [
    'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', config.script, '-Status', '-TaskName', config.task,
  ], config.timeoutMs);
  if (!result.ok) {
    const value = { available: false, enabled: true, error: `PC のスリープ状態を取得できませんでした（${lastLine(result)}）` };
    cache = { at: Date.now(), value };
    return value;
  }
  const data = parseJsonOutput(result.stdout);
  if (!data || data.ok !== true) {
    const value = { available: false, enabled: true, error: data?.error || 'PC のスリープ状態を読み取れませんでした' };
    cache = { at: Date.now(), value };
    return value;
  }
  const value = { available: true, enabled: true, ...data, fetchedAt: new Date().toISOString() };
  cache = { at: Date.now(), value };
  return value;
}

/** PC のスリープを minutes 分延長する（0 なら解除して OS のスリープ設定に任せる）。 */
export async function extendPcSleep(minutes) {
  const config = pcPowerConfig();
  if (!config.enabled) {
    const error = new Error(config.configError || 'スリープ制御は設定されていません');
    error.statusCode = 400;
    throw error;
  }
  const value = Number(minutes);
  // 0 means "clear": drop the extension and let the OS sleep timer decide.
  if (!Number.isSafeInteger(value) || value < 0 || value > config.maxExtendMinutes) {
    const error = new Error(`minutes は 0（解除）または 1〜${config.maxExtendMinutes} の整数で指定してください`);
    error.statusCode = 400;
    throw error;
  }
  const result = await runSsh(config, [
    'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', config.script, '-ExtendMinutes', String(value), '-TaskName', config.task,
  ], config.timeoutMs);
  if (!result.ok) {
    const error = new Error(`PC のスリープ延長を実行できませんでした（${lastLine(result)}）`);
    error.statusCode = 502;
    throw error;
  }
  const data = parseJsonOutput(result.stdout);
  if (!data) {
    const error = new Error('PC のスリープ延長の結果を読み取れませんでした');
    error.statusCode = 502;
    throw error;
  }
  if (data.ok !== true) {
    let message = data.error || 'PC のスリープ延長を実行できませんでした';
    if (data.loggedOn === false) message = 'PC にログオンしているユーザーがいません。ログオンしてから再試行してください';
    else if (data.taskRun === false) message = 'keep_awake タスクを開始できませんでした';
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }
  cache = { at: 0, value: null };
  return { ...data, enabled: true };
}
