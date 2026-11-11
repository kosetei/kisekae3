// ComfyUI のオンデマンド起動（#10）。
//
// 流れ: /system_stats を確認 → PC が停止していれば WOL → PC の起動待ち →
// Windows のタスク スケジューラに登録済みのタスクを `ssh <user>@<host> schtasks /Run /TN <task>` で実行 →
// /system_stats が応答するまで待つ。COMFYUI_KEEP_AWAKE_TASK があれば、スリープを防ぐタスクも同じ方法で実行する。
// 起動しているかの判断は /system_stats だけを使う（タスクの Status は当てにしない。
// start_comfy.bat 側でも 8188 が LISTENING なら何もせずに終わる）。
//
// ガード:
// - 対象ホストは COMFYUI_URL のホストだけ。タスク名と SSH ユーザーは環境変数の固定値だけを使い、
//   リクエストからは受け取らない（受け付けるのは VRAM ガードを無視する force だけ）。
// - ssh はシェルを通さず引数配列で実行し、タスク名・ユーザー・ホストは英数字などに限定する。
// - 同時に呼ばれても 1 つのジョブにまとめ（single-flight）、/Run は最低間隔をあけて送る。
import { spawn } from 'node:child_process';
import { checkComfyuiHttp, checkTcpPort, comfyuiTarget, isMockGenerator, sendWakeOnLan } from './generator.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SSH_COMMAND_TIMEOUT_MS = 20000;

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/**
 * 環境変数から起動の設定を読む。COMFYUI_START_TASK が未設定なら機能は無効。
 */
export function launcherConfig() {
  const { base, host, serverPort } = comfyuiTarget();
  const task = (process.env.COMFYUI_START_TASK || '').trim();
  const user = (process.env.COMFYUI_SSH_USER || '').trim();
  const keepAwakeTask = (process.env.COMFYUI_KEEP_AWAKE_TASK || '').trim();
  const vramGuard = Number(process.env.COMFYUI_VRAM_GUARD_MB);
  let configError = null;
  if (task && !SAFE_NAME.test(task)) configError = 'COMFYUI_START_TASK に使えない文字が含まれています（英数字と _ . - のみ）';
  else if (task && !SAFE_NAME.test(user)) configError = 'COMFYUI_SSH_USER が未設定か、使えない文字が含まれています（英数字と _ . - のみ）';
  else if (task && !SAFE_HOST.test(host)) configError = `COMFYUI_URL のホスト名 ${host} は起動の対象にできません`;
  else if (task && keepAwakeTask && !SAFE_NAME.test(keepAwakeTask)) configError = 'COMFYUI_KEEP_AWAKE_TASK に使えない文字が含まれています（英数字と _ . - のみ）';
  return {
    enabled: Boolean(task) && !configError && !isMockGenerator(),
    configError,
    task,
    keepAwakeTask: keepAwakeTask || null,
    user,
    host,
    base,
    serverPort,
    sshBin: process.env.COMFYUI_SSH_BIN || 'ssh',
    autoStart: truthy(process.env.AUTO_START),
    wakeTimeoutMs: positiveInt('COMFYUI_WAKE_TIMEOUT_MS', 180000),
    startTimeoutMs: positiveInt('COMFYUI_START_TIMEOUT_MS', 180000),
    pollIntervalMs: positiveInt('COMFYUI_POLL_INTERVAL_MS', 5000),
    resumeGraceMs: positiveInt('COMFYUI_RESUME_GRACE_MS', 15000),
    minRunIntervalMs: positiveInt('COMFYUI_START_MIN_INTERVAL_MS', 120000),
    vramGuardMb: Number.isFinite(vramGuard) && vramGuard > 0 ? vramGuard : null,
    wolAvailable: Boolean(process.env.WOL_MAC),
  };
}

/** ssh をシェルなしで実行する。リモートのコマンドは固定の引数だけ。 */
function runSsh(config, remoteArgs) {
  return new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '--',
      `${config.user}@${config.host}`,
      ...remoteArgs,
    ];
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(config.sshBin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr: error.message });
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nssh timed out`.trim() });
    }, SSH_COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// ジョブの状態（single-flight）
// ---------------------------------------------------------------------------

let current = null; // 実行中のジョブの Promise
// 最低間隔は「送ろうとした時刻」で数える（ssh が失敗し続ける環境でも、POST のたびに ssh を起動しないように）
let lastRunAt = 0;  // 最後に start_comfy の schtasks /Run を送ろうとした時刻
let lastKeepAwakeAt = 0; // 最後に keep_awake の schtasks /Run を送ろうとした時刻
let lastVramCheck = null; // 最後の nvidia-smi の結果 { at, used }。最低間隔内は使い回す
let jobExplicit = false; // 実行中のジョブが POST /api/comfyui/ensure から明示的に要求されたか
let jobForce = false; // 実行中のジョブで VRAM ガードを無視するか（実行中のジョブに合流した force も反映する）
let progress = { phase: 'idle', inProgress: false, startedAt: null, updatedAt: null, finishedAt: null, message: '' };

function update(patch) {
  progress = { ...progress, ...patch, updatedAt: new Date().toISOString() };
}

function finish(phase, message, extra = {}) {
  update({ phase, message, inProgress: false, finishedAt: new Date().toISOString(), ...extra });
  return snapshot();
}

/** 現在の起動処理の状態。 */
export function ensureStatus() {
  const config = launcherConfig();
  return {
    ...snapshot(),
    enabled: config.enabled,
    autoStart: config.enabled && config.autoStart,
    configError: config.configError,
  };
}

function snapshot() {
  return {
    ...progress,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastKeepAwakeAt: lastKeepAwakeAt ? new Date(lastKeepAwakeAt).toISOString() : null,
  };
}

export function isEnsureInProgress() {
  return Boolean(current);
}

/**
 * 起動処理を始める（実行中ならそれに合流する）。完了を待たずにすぐ状態を返す。
 * @param {{force?: boolean, explicit?: boolean}} [options]
 *   force: VRAM ガードを無視して起動する
 *   explicit: 画面から明示的に要求された（ComfyUI がすでに動いていても keep_awake を実行する）
 */
export function startEnsure(options = {}) {
  const config = launcherConfig();
  if (!config.enabled) {
    const error = new Error(config.configError || 'ComfyUI の起動は設定されていません（COMFYUI_START_TASK が未設定）');
    error.statusCode = config.configError ? 500 : 400;
    throw error;
  }
  const joined = Boolean(current);
  if (!current) {
    jobExplicit = false;
    jobForce = false;
  }
  if (options.explicit === true) jobExplicit = true;
  // VRAM ガードの判定前なら、合流した force も効く（判定後に合流した場合は、次の起動で force を送り直す）
  if (options.force === true) jobForce = true;
  if (!current) {
    update({
      phase: 'checking', inProgress: true, startedAt: new Date().toISOString(), finishedAt: null,
      message: 'ComfyUI の状態を確認しています', code: null, vramUsedMb: null, vramThresholdMb: null, warnings: [],
    });
    current = runEnsure(config)
      .catch((error) => finishWithWarnings('error', `起動処理に失敗しました: ${error.message}`, { code: 'internal' }))
      .finally(() => { current = null; });
  }
  return { ...ensureStatus(), joined };
}

/** 起動処理を始めて（または合流して）、終わるまで待つ。/api/generate の AUTO_START 用。 */
export async function ensureAndWait(options = {}) {
  startEnsure(options);
  if (current) await current;
  return ensureStatus();
}

/**
 * keep_awake タスクを実行する（設定されているときだけ）。スクリプト側に単一インスタンスのガードがあるので
 * 何度呼んでもよいが、start_comfy と同じく最低間隔をあける。失敗しても ensure は失敗にせず、警告を残す。
 */
async function runKeepAwake(config) {
  const result = await sendKeepAwake(config);
  if (result.result === 'failed') update({ warnings: [...(progress.warnings || []), result.message] });
}

/**
 * keep_awake の schtasks /Run を送る（最低間隔つき）。
 * @returns {Promise<{result: 'disabled'|'throttled'|'sent'|'failed', message: string, retryAfterMs?: number}>}
 */
async function sendKeepAwake(config) {
  if (!config.keepAwakeTask) return { result: 'disabled', message: 'スリープ防止タスク（COMFYUI_KEEP_AWAKE_TASK）が設定されていません' };
  const since = Date.now() - lastKeepAwakeAt;
  if (lastKeepAwakeAt && since < config.minRunIntervalMs) {
    const retryAfterMs = config.minRunIntervalMs - since;
    return {
      result: 'throttled', retryAfterMs,
      message: `${Math.round(since / 1000)} 秒前に実行したばかりです（あと ${Math.ceil(retryAfterMs / 1000)} 秒で再実行できます）`,
    };
  }
  lastKeepAwakeAt = Date.now();
  const result = await runSsh(config, ['schtasks', '/Run', '/TN', config.keepAwakeTask]);
  if (result.ok) return { result: 'sent', message: `スリープ防止タスク（${config.keepAwakeTask}）を実行しました` };
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-1)[0] || `exit ${result.code}`;
  return { result: 'failed', message: `スリープ防止タスク（${config.keepAwakeTask}）を実行できませんでした（${detail}）` };
}

// 終了時のメッセージに keep_awake の警告を付ける
function finishWithWarnings(phase, message, extra) {
  const warnings = progress.warnings || [];
  return finish(phase, warnings.length ? `${message}（注意: ${warnings.join(' / ')}）` : message, extra);
}

/** GPU のメモリ使用量（MB）。取得できなければ null。最低間隔内は前回の結果を使う */
async function readVramUsedMb(config) {
  if (lastVramCheck && Date.now() - lastVramCheck.at < config.minRunIntervalMs) return lastVramCheck.used;
  const at = Date.now();
  const result = await runSsh(config, ['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits']);
  const values = result.ok
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
    : [];
  const used = values.length ? Math.max(...values) : null;
  lastVramCheck = { at, used };
  return used;
}

async function runEnsure(config) {
  const { base, host, serverPort } = config;
  if (await checkComfyuiHttp(base)) {
    // 画面から明示的に要求されたときは、使っている間 PC が眠らないように keep_awake も実行する
    if (jobExplicit) await runKeepAwake(config);
    return finishWithWarnings('already_running', 'ComfyUI はすでに起動しています');
  }

  // 1. PC が停止していれば WOL で起こして待つ
  let pcUp = await checkTcpPort(host, serverPort);
  if (!pcUp) {
    if (!config.wolAvailable) {
      return finish('error', `PC（${host}）が応答しません。WOL_MAC が未設定のため電源を入れられません`, { code: 'pc_down_no_wol' });
    }
    update({ phase: 'waking', message: 'PC に起動信号（WOL）を送っています' });
    await sendWakeOnLan();
    update({ phase: 'waiting_pc', message: `PC の起動を待っています（最大 ${Math.round(config.wakeTimeoutMs / 1000)} 秒。休止状態からの復帰は時間がかかります）` });
    pcUp = await waitFor(async () => (await checkTcpPort(host, serverPort)) || checkComfyuiHttp(base), config.wakeTimeoutMs, config.pollIntervalMs);
    if (!pcUp) {
      return finish('timeout', `PC が ${Math.round(config.wakeTimeoutMs / 1000)} 秒以内に起動しませんでした`, { code: 'pc_timeout' });
    }
    // スリープ復帰なら ComfyUI がそのまま動いていることがあるので、少し待ってから判断する
    update({ phase: 'waiting_comfyui', message: 'PC が起動しました。ComfyUI が動いているか確認しています' });
    if (await waitFor(() => checkComfyuiHttp(base), config.resumeGraceMs, Math.min(config.pollIntervalMs, config.resumeGraceMs))) {
      if (jobExplicit) await runKeepAwake(config);
      return finishWithWarnings('ready', 'ComfyUI が応答しました');
    }
  }

  // 2. 直前に起動コマンドを送ったばかりなら、VRAM の確認も /Run もせずに応答を待つ
  //    （keep_awake は専用の最低間隔で判断する）。起動中かどうかはタスクの Status ではなく /system_stats だけで判断する
  const sinceLastRun = Date.now() - lastRunAt;
  if (lastRunAt && sinceLastRun < config.minRunIntervalMs) {
    update({ phase: 'starting', message: `直前（${Math.round(sinceLastRun / 1000)} 秒前）に起動したばかりなので、起動コマンドは送らずに応答を待ちます` });
    await runKeepAwake(config);
  } else {
    // 3. VRAM ガード（設定されているときだけ）
    if (config.vramGuardMb !== null && !jobForce) {
      update({ phase: 'checking', message: 'GPU のメモリ使用量を確認しています' });
      const used = await readVramUsedMb(config);
      if ((used === null || used > config.vramGuardMb) && !jobForce) {
        return finishWithWarnings('blocked_vram', used === null
          ? 'GPU のメモリ使用量を確認できなかったため、起動を保留しました'
          : `GPU のメモリ使用量（${used} MB）がしきい値（${config.vramGuardMb} MB）を超えているため、起動を保留しました`, {
          code: 'blocked_vram', vramUsedMb: used, vramThresholdMb: config.vramGuardMb,
        });
      }
    }
    // 4. タスクを実行する。モデルの読み込み中に PC が眠らないよう、先にスリープ防止タスクを実行する
    update({ phase: 'starting', message: `ComfyUI の起動タスク（${config.task}）を実行しています` });
    await runKeepAwake(config);
    lastRunAt = Date.now();
    const run = await runSsh(config, ['schtasks', '/Run', '/TN', config.task]);
    if (!run.ok) {
      const detail = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(-1)[0] || `exit ${run.code}`;
      return finishWithWarnings('error', `起動タスクを実行できませんでした（${detail}）。SSH の鍵認証を確認してください`, { code: 'run_failed' });
    }
  }

  // 5. ComfyUI の応答を待つ
  update({ phase: 'waiting_comfyui', message: `ComfyUI の起動を待っています（最大 ${Math.round(config.startTimeoutMs / 1000)} 秒）` });
  if (await waitFor(() => checkComfyuiHttp(base), config.startTimeoutMs, config.pollIntervalMs)) {
    return finishWithWarnings('ready', 'ComfyUI が起動しました');
  }
  // Interactive only のタスクは、ログオンセッションがないと /Run が成功を返しても何も起きないことがある
  return finishWithWarnings('timeout', `ComfyUI が ${Math.round(config.startTimeoutMs / 1000)} 秒以内に応答しませんでした。PC に ${config.user} がログオンしているか（再起動後は一度ログオンが必要）と、起動タスクの実行結果を確認してください`, { code: 'comfyui_timeout' });
}
