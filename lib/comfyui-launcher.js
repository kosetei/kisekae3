// ComfyUI のオンデマンド起動（#10）。
//
// 流れ: /system_stats を確認 → PC が停止していれば WOL → PC の起動待ち →
// Windows のタスク スケジューラに登録済みのタスクを `ssh <user>@<host> schtasks /Run /TN <task>` で実行 →
// /system_stats が応答するまで待つ。
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
  const vramGuard = Number(process.env.COMFYUI_VRAM_GUARD_MB);
  let configError = null;
  if (task && !SAFE_NAME.test(task)) configError = 'COMFYUI_START_TASK に使えない文字が含まれています（英数字と _ . - のみ）';
  else if (task && !SAFE_NAME.test(user)) configError = 'COMFYUI_SSH_USER が未設定か、使えない文字が含まれています（英数字と _ . - のみ）';
  else if (task && !SAFE_HOST.test(host)) configError = `COMFYUI_URL のホスト名 ${host} は起動の対象にできません`;
  return {
    enabled: Boolean(task) && !configError && !isMockGenerator(),
    configError,
    task,
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
    const timer = setTimeout(() => {
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
let lastRunAt = 0;  // 最後に schtasks /Run を送った時刻
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
  return { ...progress, lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null };
}

export function isEnsureInProgress() {
  return Boolean(current);
}

/**
 * 起動処理を始める（実行中ならそれに合流する）。完了を待たずにすぐ状態を返す。
 * @param {{force?: boolean}} [options] force: VRAM ガードを無視して起動する
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
    update({
      phase: 'checking', inProgress: true, startedAt: new Date().toISOString(), finishedAt: null,
      message: 'ComfyUI の状態を確認しています', code: null, vramUsedMb: null, vramThresholdMb: null,
    });
    current = runEnsure(config, { force: options.force === true })
      .catch((error) => finish('error', `起動処理に失敗しました: ${error.message}`, { code: 'internal' }))
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

async function runEnsure(config, { force }) {
  const { base, host, serverPort } = config;
  if (await checkComfyuiHttp(base)) {
    return finish('already_running', 'ComfyUI はすでに起動しています');
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
      return finish('ready', 'ComfyUI が応答しました');
    }
  }

  // 2. VRAM ガード（設定されているときだけ）
  if (config.vramGuardMb !== null && !force) {
    update({ phase: 'checking', message: 'GPU のメモリ使用量を確認しています' });
    const result = await runSsh(config, ['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits']);
    const values = result.ok
      ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
      : [];
    const used = values.length ? Math.max(...values) : null;
    if (used === null || used > config.vramGuardMb) {
      return finish('blocked_vram', used === null
        ? 'GPU のメモリ使用量を確認できなかったため、起動を保留しました'
        : `GPU のメモリ使用量（${used} MB）がしきい値（${config.vramGuardMb} MB）を超えているため、起動を保留しました`, {
        code: 'blocked_vram', vramUsedMb: used, vramThresholdMb: config.vramGuardMb,
      });
    }
  }

  // 3. タスクを実行する（実行中・直前に送ったばかりなら送らずに待つ）
  update({ phase: 'starting', message: `ComfyUI の起動タスク（${config.task}）を確認しています` });
  const query = await runSsh(config, ['schtasks', '/Query', '/TN', config.task, '/FO', 'CSV', '/NH']);
  const alreadyRunning = query.ok && /"(Running|実行中)"/i.test(query.stdout);
  const sinceLastRun = Date.now() - lastRunAt;
  if (alreadyRunning) {
    update({ message: '起動タスクはすでに実行中です。ComfyUI の応答を待ちます' });
  } else if (lastRunAt && sinceLastRun < config.minRunIntervalMs) {
    update({ message: `直前（${Math.round(sinceLastRun / 1000)} 秒前）に起動したばかりなので、起動コマンドは送らずに応答を待ちます` });
  } else {
    update({ message: `ComfyUI の起動タスク（${config.task}）を実行しています` });
    const run = await runSsh(config, ['schtasks', '/Run', '/TN', config.task]);
    if (!run.ok) {
      const detail = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(-1)[0] || `exit ${run.code}`;
      return finish('error', `起動タスクを実行できませんでした（${detail}）。SSH の鍵認証と、PC にログオン中かを確認してください`, { code: 'run_failed' });
    }
    lastRunAt = Date.now();
  }

  // 4. ComfyUI の応答を待つ
  update({ phase: 'waiting_comfyui', message: `ComfyUI の起動を待っています（最大 ${Math.round(config.startTimeoutMs / 1000)} 秒）` });
  if (await waitFor(() => checkComfyuiHttp(base), config.startTimeoutMs, config.pollIntervalMs)) {
    return finish('ready', 'ComfyUI が起動しました');
  }
  return finish('timeout', `ComfyUI が ${Math.round(config.startTimeoutMs / 1000)} 秒以内に応答しませんでした`, { code: 'comfyui_timeout' });
}
