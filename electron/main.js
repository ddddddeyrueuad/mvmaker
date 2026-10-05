// Electron 主进程：启动内置 Express 后端（作为 Node 子进程），等待端口就绪后加载前端窗口。
// 发行包形态：本地零 Python（音乐分析走远程或 mock），ffmpeg 随包，agnes 走远程 API。
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 3001;
const isPackaged = app.isPackaged;

// ---- 关键路径解析（区分开发 / 打包）----
// 打包后有两种资源位置：
//   ① asar 内部：server/、client/、node_modules/ 等代码（electron-builder files 规则打包进 asar）
//   ② resources/ 目录：ffmpeg 等二进制（extraResources 解压到 process.resourcesPath）
// 开发时：所有资源都在仓库根目录下。
//
// ⚠️ 绝不能用 process.resourcesPath 去找 asar 内的代码！resources/ 只放 extraResources。
const APP_ROOT = path.join(__dirname, '..');  // asar 根目录（开发时=项目根，打包时=asar 内根）
const RES = isPackaged ? process.resourcesPath : path.join(APP_ROOT, 'resources');  // 二进制资源目录
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'src', 'index.js');
const CLIENT_DIST = path.join(APP_ROOT, 'client', 'dist');
const FFMPEG_DIR = path.join(RES, 'ffmpeg');
const FFMPEG_PATH = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFPROBE_PATH = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

// 可写数据目录（userData）：产物 uploads + 可写 .env + 归档输出（asar 内不可写，必须落 userData）
const USER_DATA = app.getPath('userData');
const UPLOADS_DIR = path.join(USER_DATA, 'uploads');
const ENV_FILE = path.join(USER_DATA, 'config.env');
const REPORT_DIR = path.join(USER_DATA, 'report');
const TEMP_CLIP_DIR = path.join(USER_DATA, 'temp clip');
const OUTPUT_DIR = path.join(USER_DATA, 'output');

let serverProc = null;
let _serverProcRef = null; // 供 detached 启动方式存储进程引用
let mainWindow = null;

// ---- 安全启动后端：多层策略对抗杀软/远程桌面拦截 ----
//
// 向日葵等安全软件会在 Electron 主进程上 hook CreateProcessW，
// 拦截该进程发起的几乎所有子进程创建（fork / spawn / 甚至 cmd.exe），返回 ENOENT。
// 已验证被拦路径：Programs / AppData(Roaming|Local) / D盘根目录 / system32\cmd.exe
//
// 对抗策略（按优先级）：
//   1) fork() —— 正常环境首选，最快最稳，支持 IPC
//   2) spawn + detached:true —— 打断父子进程关系，子进程成为独立进程组 leader
//      （杀软 hook 可能仅针对同一进程组的直接子进程）
//   3) wscript.exe 执行 VBS 脚本 —— 完全不同的执行链路（WSH），可能绕过 hook
//   4) 写 .bat → spawn(detached) 执行 bat —— 双重中转
//
// 关键：所有方案的 error 监听器必须在 spawn 调用之前绑定（消除竞态条件，
//       否则异步 ENOENT 会变成未捕获异常弹窗）。
const { spawn } = require('node:child_process');
// original-fs 绕过 Electron 的 asar 文件系统拦截，用于写入真实磁盘文件
const originalFs = require('original-fs') || fs;

// 非 fork 方案使用的解压后 server 目录（asar 外的真实文件系统路径）
const SERVER_RUNTIME_DIR = path.join(USER_DATA, 'server-runtime');

// 记录当前使用的启动方案和路径（供诊断用）
let _activeLauncherName = '';
let _activeEntryPath = '';

/**
 * 确保 server 代码 + 依赖已从 asar 解压到 userData（供 detached/VBS/bat 方案使用）。
 * fork() 不需要此步骤（Electron 内部处理 asar 路径）。
 *
 * 关键：必须连同 node_modules 一起解压！asar 内 node_modules 在根目录（含 express 等），
 *       若只解压 server/src，解压后的 index.js 用 ELECTRON_RUN_AS_NODE 运行时
 *       import express 会因找不到 node_modules 而崩溃。
 *
 * 原理：Electron 主进程内的 fs 可直接读取 asar 内文件（Electron 内部 hook），
 *       用 originalFs 写入解压后的真实磁盘副本。不依赖任何外部 asar 解析模块。
 * 返回解压后的 index.js 路径。
 */
function ensureServerExtracted() {
  if (!isPackaged) return SERVER_ENTRY; // 开发态直接用源码

  const extractedEntry = path.join(SERVER_RUNTIME_DIR, 'server', 'src', 'index.js');
  const nmCheck = path.join(SERVER_RUNTIME_DIR, 'node_modules', 'express');
  const versionMarker = path.join(SERVER_RUNTIME_DIR, '.extracted-version');

  // 版本一致性检查：只有当「解压目录存在」且「版本标记与当前 app 版本一致」时才复用缓存。
  // 否则必须重新解压——否则升级安装后旧 server-runtime 代码会被沿用，导致新版修复不生效。
  const appVersion = app.getVersion();
  let cachedVersion = '';
  try { cachedVersion = originalFs.readFileSync(versionMarker, 'utf8').trim(); } catch { /* 无标记文件视为不匹配 */ }
  const versionMatch = cachedVersion === appVersion;

  try {
    if (versionMatch && fs.existsSync(extractedEntry) && fs.existsSync(nmCheck)) {
      console.log(`[electron] 复用已解压 server-runtime（版本 ${appVersion} 匹配）`);
      return extractedEntry;
    }
  } catch { /* ignore */ }

  // 版本不匹配或文件缺失 → 清理旧解压目录，重新从 asar 解压
  if (!versionMatch && cachedVersion) {
    console.log(`[electron] 版本变更 ${cachedVersion} → ${appVersion}，清理旧 server-runtime 并重新解压`);
  }
  try { originalFs.rmSync(SERVER_RUNTIME_DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞，后续 mkdirSync 会覆盖 */ }

  console.log('[electron] 从 asar 解压 server + 依赖到:', SERVER_RUNTIME_DIR);
  try {
    // 递归复制单个 asar 子目录 → 真实磁盘
    function copyAsarSubdir(relAsarPath, relTarget) {
      const srcDir = path.join(APP_ROOT, relAsarPath);  // 从 asar 内读取（不是 RES！）
      const dstDir = path.join(SERVER_RUNTIME_DIR, relTarget);
      originalFs.mkdirSync(dstDir, { recursive: true });
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
          copyAsarSubdir(path.join(relAsarPath, entry.name), path.join(relTarget, entry.name));
        } else {
          const content = fs.readFileSync(srcPath);
          originalFs.writeFileSync(dstPath, content);
        }
      }
    }

    copyAsarSubdir('server', 'server');             // server/ → server-runtime/server/
    copyAsarSubdir('node_modules', 'node_modules'); // node_modules/ → server-runtime/node_modules/
    // 写入版本标记，下次启动同版本时直接复用缓存（跳过解压，加速启动）
    try { originalFs.writeFileSync(versionMarker, appVersion); } catch { /* 写标记失败不影响本次运行 */ }
    console.log(`[electron] Server + 依赖解压完成（含 node_modules），版本标记=${appVersion}`);
    return extractedEntry;
  } catch (e) {
    console.error('[electron] 解压失败:', e.message);
    return SERVER_ENTRY; // 回退（大概率也会失败但至少不 crash）
  }
}

function buildServerEnv() {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(PORT),
    UPLOADS_DIR,
    CLIENT_DIST,
    ENV_FILE,
    FFMPEG_PATH,
    FFPROBE_PATH,
    REPORT_DIR,
    TEMP_CLIP_DIR,
    OUTPUT_DIR,
    MERT_LOCAL: '0',
    NODE_ENV: 'production',
  };
  if (isPackaged) {
    for (const k of Object.keys(env)) {
      if (k === 'MERT_LOCAL') continue;
      if (k.startsWith('AGNES_') || k.startsWith('MERT_')) delete env[k];
    }
  }
  return env;
}

/**
 * 安全创建子进程：先绑定 error 监听器，再调用 spawn。
 * 避免竞态条件：OS 级拦截可能在 spawn 返回后、on('error') 注册前触发 → 未捕获异常。
 */
function safeSpawn(spawnFn) {
  const { ChildProcess } = require('node:child_process');
  // 手动创建空壳 ChildProcess，先挂监听器
  const proc = new ChildProcess();
  let resolved = false;

  // 先绑定 error 监听（关键！在 spawn 实际调用之前）
  proc.on('error', (err) => {
    console.error(`[electron] safeSpawn 异步错误: ${err.message} (code=${err.code})`);
    if (!resolved) {
      resolved = true;
      // 将错误存储起来供外部检查
      proc._safeSpawnError = err;
    }
  });

  // 然后才真正执行 spawn
  try {
    const result = spawnFn(proc);
    resolved = true;
    return result;
  } catch (e) {
    resolved = true;
    proc._safeSpawnError = e;
    throw e;
  }
}

/** 方案1：标准 fork（正常环境）
 *  fork 子进程继承主进程的 Electron 运行时，天然支持 asar 路径解析。
 *  ⚠️ 绝不能传 ELECTRON_RUN_AS_NODE！该变量会让 Electron 以纯 Node 模式运行，
 *      禁用 asar 支持 → 子进程找不到 server/src/index.js → ENOENT(-4058)。 */
function tryFork(env) {
  console.log(`[electron] [方案1] fork(), execPath=${process.execPath}`);
  // fork 继承 Electron 主进程的完整运行时环境（含 asar 支持），
  // 必须删除 ELECTRON_RUN_AS_NODE，否则子进程无法读取 asar 内文件
  const forkEnv = { ...env };
  delete forkEnv.ELECTRON_RUN_AS_NODE;
  const proc = fork(SERVER_ENTRY, [], {
    execPath: process.execPath,
    env: forkEnv,
    cwd: path.join(APP_ROOT, 'server'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  console.log(`[electron] [方案1] 成功 pid=${proc.pid}`);
  return proc;
}

/** 方案2：spawn + detached:true
 *  detached 让子进程成为新进程组 leader，脱离父进程组。
 *  安全软件 hook 可能只针对同进程组内的直接子进程。
 *  注意：必须使用解压后的 server 路径（普通 Node.js 无法读 asar）。
 *  ⚠️ 必须用 safeSpawn 包装！否则 spawn 的异步 ENOENT 会变成 uncaught exception。 */
function tryDetached(env) {
  const exePath = process.execPath;
  const serverScript = ensureServerExtracted(); // 解压后的真实路径
  const serverCwd = path.join(SERVER_RUNTIME_DIR, 'server'); // 用解压目录的 server/ 作为 cwd
  console.log(`[electron] [方案2] spawn(detached): "${exePath}" "${serverScript}"`);

  const proc = safeSpawn(() =>
    spawn(exePath, [serverScript], {
      detached: true,
      windowsHide: true,
      env,
      cwd: serverCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  proc.unref();
  console.log(`[electron] [方案2] 成功 pid=${proc.pid}`);
  return proc;
}

/** 方案3：wscript.exe 执行 VBS 脚本
 *  WSH (Windows Script Host) 是独立于 cmd.exe 的脚本宿主，
 *  通过 WScript.Shell.Run 启动进程走的是 COM 接口，不是 CreateProcessW 直调。
 *  必须使用解压后的 server 路径（普通 Node.js 无法读 asar）。 */
function tryVbs(env) {
  const vbsPath = path.join(USER_DATA, 'start-server.vbs');
  const exePath = process.execPath;
  const serverScript = ensureServerExtracted(); // 解压后的真实路径
  const serverCwd = path.join(SERVER_RUNTIME_DIR, 'server');

  // 将环境变量写入 VBS 内联设置
  const envSetLines = Object.entries(env).map(([k, v]) =>
    `  WshEnv("${k}") = "${v.replace(/"/g, '""')}"`
  ).join('\n');

  const vbsContent = [
    'Option Explicit',
    'Dim Shell, WshEnv',
    'Set Shell = WScript.CreateObject("WScript.Shell")',
    'Set WshEnv = Shell.Environment("Process")',
    envSetLines,
    `Shell.CurrentDirectory = "${serverCwd.replace(/\\/g, '\\\\')}"`,
    `Shell.Run """${exePath}""" """${serverScript}""", 0, False`,
  ].join('\r\n');

  fs.writeFileSync(vbsPath, vbsContent, 'utf8');
  console.log(`[electron] [方案3] 已写入 VBS: ${vbsPath}`);

  // 用 detached 方式启动 wscript（避免自身也被拦）— safeSpawn 防止异步 ENOENT 崩溃主进程
  const proc = safeSpawn(() =>
    spawn('wscript.exe', [vbsPath], {
      detached: true,
      windowsHide: true,
      env,
      cwd: serverCwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  );
  proc.unref();
  console.log(`[electron] [方案3] wscript pid=${proc.pid}`);
  return proc;
}

/** 方案4：写 bat → detached spawn bat
 *  必须使用解压后的 server 路径（普通 Node.js 无法读 asar）。 */
function tryDetachedBat(env) {
  const batPath = path.join(USER_DATA, 'start-server.bat');
  const exePath = process.execPath;
  const serverScript = ensureServerExtracted(); // 解压后的真实路径
  const serverCwd = path.join(SERVER_RUNTIME_DIR, 'server');

  const batContent = [
    '@echo off',
    `cd /d "${serverCwd}"`,
    `set ELECTRON_RUN_AS_NODE=1`,
    `set PORT=${PORT}`,
    `set UPLOADS_DIR=${UPLOADS_DIR}`,
    `set CLIENT_DIST=${CLIENT_DIST}`,
    `set ENV_FILE=${ENV_FILE}`,
    `set FFMPEG_PATH=${FFMPEG_PATH}`,
    `set FFPROBE_PATH=${FFPROBE_PATH}`,
    `set REPORT_DIR=${REPORT_DIR}`,
    `set TEMP_CLIP_DIR=${TEMP_CLIP_DIR}`,
    `set OUTPUT_DIR=${OUTPUT_DIR}`,
    `set MERT_LOCAL=0`,
    `set NODE_ENV=production`,
    `if defined AGNES_API_KEY set AGNES_API_KEY=`,
    `if defined AGNES_BASE_URL set AGNES_BASE_URL=`,
    `if defined MERT_URL set MERT_URL=`,
    `if defined MERT_API_KEY set MERT_API_KEY=`,
    `"${exePath}" "${serverScript}"`,
  ].join('\r\n');

  fs.writeFileSync(batPath, batContent, 'utf8');
  console.log(`[electron] [方案4] 已写入 bat: ${batPath}`);

  const proc = safeSpawn(() =>
    spawn(batPath, [], {
      detached: true,
      windowsHide: true,
      env,
      cwd: serverCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  proc.unref();
  console.log(`[electron] [方案4] bat detached pid=${proc.pid}`);
  return proc;
}

/** 启动内置后端：按优先级尝试多种方案对抗杀软拦截。 */
function startServer() {
  const env = buildServerEnv();

  // 预先执行解压（所有非 fork 方案都依赖它）
  const extractedEntry = ensureServerExtracted();
  const extractionOk = extractedEntry !== SERVER_ENTRY ||
    fs.existsSync(extractedEntry) && fs.existsSync(path.join(SERVER_RUNTIME_DIR, 'node_modules', 'express'));
  console.log(`[electron] 解压状态: ${extractionOk ? 'OK' : '失败/不完整'}, 路径: ${extractedEntry}`);

  // 构建启动方案列表
  const launchers = [
    { name: 'fork',     fn: () => tryFork(env), needsExtraction: false },
  ];

  // 只有解压成功时才启用非 fork 方案（否则必然 ENOENT）
  if (extractionOk) {
    launchers.push(
      { name: 'detached', fn: () => tryDetached(env), needsExtraction: true },
      { name: 'vbs',      fn: () => tryVbs(env),      needsExtraction: true },
      { name: 'bat-detach', fn: () => tryDetachedBat(env), needsExtraction: true }
    );
  } else {
    console.warn('[electron] 解压失败，禁用 detached/VBS/bat 方案（它们无法读取 asar 内文件）');
  }

  let lastError = null;
  let serverProc = null;

  for (const launcher of launchers) {
    // 重置异步错误标志（用于检测 OS 延迟拦截）
    let asyncError = null;
    let asyncErrorResolved = false;

    try {
      serverProc = launcher.fn();
      _activeLauncherName = launcher.name; // 记录当前方案名

      // ⭐ 关键验证：检查进程是否真正创建成功
      // 向日葵等杀软拦截 CreateProcessW 时，fork()/spawn() 不抛同步异常，
      // 但返回的 ChildProcess 对象 pid=undefined（进程从未被 OS 创建）。
      // 必须在 break 前检测这种情况，否则会误判为"成功"而跳过后续方案。
      if (!serverProc.pid && serverProc.pid !== 0) {
        const fakePidErr = new Error(
          `[${launcher.name}] 进程创建失败：pid 为空（OS 未分配进程 ID）。` +
          `可能原因：安全软件（向日葵/杀软）拦截了子进程创建。`
        );
        fakePidErr.code = 'NO_PID';
        throw fakePidErr;
      }

      // 绑定输出流
      serverProc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
      serverProc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

      // 检查是否有延迟错误（safeSpawn 存储的）
      if (serverProc._safeSpawnError) {
        throw serverProc._safeSpawnError;
      }

      // 绑定 error 处理（用于检测 OS 延迟拦截——pid 有值但随后崩溃）
      serverProc.on('error', (err) => {
        console.error(`[electron] [${launcher.name}] 异步错误 (code=${err.code}): ${err.message}`);
        asyncError = err;
        asyncErrorResolved = true;
      });

      serverProc.on('exit', (code) => {
        console.log(`[electron] [${launcher.name}] 后端退出 code=${code}`);
      });

      lastError = null; // 标记成功
      console.log(`[electron] [${launcher.name}] 启动成功，pid=${serverProc.pid}`);
      break; // ✅ 真正成功：有有效 pid
    } catch (e) {
      lastError = e;
      console.warn(`[electron] [${launcher.name}] 同步失败: ${e.message}`);
      // ⭐ 防御：给孤儿 proc 绑定 error handler，防止异步 ENOENT 变成 uncaught exception
      // （杀软拦截 spawn 时，异步 onErrorNT 可能在 proc 被丢弃后才触发）
      if (serverProc) {
        serverProc.on('error', (err) => {
          console.warn(`[electron] [${launcher.name}] 延迟异步错误(已吞掉): ${err.message}`);
        });
        try { serverProc.kill(); } catch {}
        serverProc = null;
      }
      continue;
    }
  }

  if (lastError) {
    console.error('[electron] 所有启动方案均失败:', lastError.message);
    dialog.showErrorBox('启动失败 — 安全软件拦截',
      `无法启动后端服务（安全软件拦截了所有子进程创建方式）。\n\n` +
      `已尝试：${launchers.map(l => '\n  • ' + l.name).join('')}\n` +
      `解压状态: ${extractionOk ? '成功' : '失败'}\n` +
      `最终错误：${lastError.message}\n\n` +
      `解决方案（选一）：\n` +
      `  ① 将 MVMaker.exe 加入杀软/向日葵白名单后重启\n` +
      `  ② 安装时选择「为所有用户安装」（perMachine=true）\n` +
      `  ③ 临时退出向日葵远程桌面后重启应用`);
    return;
  }

  // 记录实际入口路径（诊断用：fork 用 asar 路径，其余用解压路径）
  _activeEntryPath = (_activeLauncherName === 'fork') ? SERVER_ENTRY : extractedEntry;

  // 保存到模块级变量（供 killServer 等使用）
  _serverProcRef = serverProc;
}

/** 已知泄露的 Agnes Key 哈希（sha256）。早期开发版曾把开发者 Key 误写入随包配置，
 * 旧安装可能已把它复制到 userData/config.env。命中即视为泄露、清空，要求用户重新填写自己的 Key。
 * 真实安全做法：开发者应到 Agnes 控制台轮换(replace)该 Key。 */
const REVOKED_AGNES_KEY_HASHES = new Set([
  '1fbb6cf81c959fd3deb442826b46ff71777c4519fbd0a9c441308e71281f3b7c',
]);

/** 若 config.env 中的 Key 命中泄露哈希，清空该行（吊销），避免打包版静默使用泄露 Key。 */
function revokeLeakedKey() {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const m = text.match(/^AGNES_API_KEY=(.*)$/m);
    if (!m) return;
    const val = m[1].trim();
    if (!val) return;
    const h = require('node:crypto').createHash('sha256').update(val).digest('hex');
    if (REVOKED_AGNES_KEY_HASHES.has(h)) {
      const cleared = text.replace(/^AGNES_API_KEY=.*$/m, 'AGNES_API_KEY=');
      fs.writeFileSync(ENV_FILE, cleared);
      console.warn('[electron] 检测到随包泄露的 Agnes Key，已自动吊销，请在界面填入你自己的 Key。');
    }
  } catch (e) {
    console.error('[electron] revokeLeakedKey 失败:', e.message);
  }
}

/** 首次运行：把随包默认 .env 复制到 userData（若不存在），保证可写持久化。 */
function ensureEnvFile() {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.mkdirSync(TEMP_CLIP_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(ENV_FILE)) {
      const bundled = path.join(APP_ROOT, 'server', '.env');
      if (fs.existsSync(bundled)) fs.copyFileSync(bundled, ENV_FILE);
      else fs.writeFileSync(ENV_FILE, '');
    }
    revokeLeakedKey();
    migrateMertTimeout();
    migrateAgnesDomain();
  } catch (e) {
    console.error('[electron] ensureEnvFile 失败:', e.message);
  }
}

/** 迁移：旧版 .env.dist 曾默认 MERT_REMOTE_TIMEOUT_MS=120000（2分钟），升级后 config.env
 *  残留该值会导致 MERT 冷启动必超时。检测到 <480000 时自动提升到 600000（10分钟）。 */
function migrateMertTimeout() {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const m = text.match(/^MERT_REMOTE_TIMEOUT_MS=(\d+)\s*$/m);
    if (!m) return;
    const val = parseInt(m[1], 10);
    if (isNaN(val) || val >= 480000) return;
    const updated = text.replace(/^MERT_REMOTE_TIMEOUT_MS=.*$/m, 'MERT_REMOTE_TIMEOUT_MS=600000');
    fs.writeFileSync(ENV_FILE, updated);
    console.log(`[electron] MERT_REMOTE_TIMEOUT_MS ${val} → 600000（旧值过低，已自动迁移）`);
  } catch (e) {
    console.error('[electron] migrateMertTimeout 失败:', e.message);
  }
}

/** 迁移：Agnes 平台域名与文本模型升级。
 *  旧：Base URL = https://apihub.agnes-ai.com/v1，文本模型 = agnes-2.0-flash
 *  新：Base URL = https://api.agnes-ai.cn/v1，文本模型 = agnes-2.5-flash
 *  config.env 仅首次从 .env.dist 复制，老用户升级后旧值会残留，导致连废弃旧地址/调已下线模型。
 *  每次启动检测并自动替换为新版（幂等：已是新值则不动）。 */
function migrateAgnesDomain() {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    let updated = text;
    let changed = false;
    if (/^AGNES_BASE_URL=https:\/\/apihub\.agnes-ai\.com\/v1\s*$/m.test(updated)) {
      updated = updated.replace(/^AGNES_BASE_URL=.*$/m, 'AGNES_BASE_URL=https://api.agnes-ai.cn/v1');
      console.log('[electron] AGNES_BASE_URL apihub.agnes-ai.com → api.agnes-ai.cn（域名已迁移）');
      changed = true;
    }
    if (/^AGNES_CHAT_MODEL=agnes-2\.0-flash\s*$/m.test(updated)) {
      updated = updated.replace(/^AGNES_CHAT_MODEL=.*$/m, 'AGNES_CHAT_MODEL=agnes-2.5-flash');
      console.log('[electron] AGNES_CHAT_MODEL agnes-2.0-flash → agnes-2.5-flash（文本模型已升级）');
      changed = true;
    }
    if (changed) fs.writeFileSync(ENV_FILE, updated);
  } catch (e) {
    console.error('[electron] migrateAgnesDomain 失败:', e.message);
  }
}

/** 轮询等待后端 /api/health 就绪。 */
function waitForServer(timeoutMs = 90000) {
  const started = Date.now();
  let lastStderr = '';  // 捕获后端最后的 stderr 输出用于诊断
  const origRef = _serverProcRef;

  // 如果后端有 stderr，收集最后 500 字符
  if (origRef && origRef.stderr) {
    origRef.stderr.on('data', (d) => { lastStderr = (lastStderr + d.toString()).slice(-500); });
  }

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        // 正确检测进程存活状态：exitCode !== null 表示进程已退出（无论正常还是崩溃）
        const proc = _serverProcRef || origRef;
        const reallyDead = !proc || proc.exitCode !== null || proc.killed;
        const pid = proc ? (proc.pid || 'undefined') : 'N/A';
        const exitCode = proc && proc.exitCode != null ? `, exitCode=${proc.exitCode}` : '';
        const stderrHint = lastStderr ? `\n后端最后日志: ${lastStderr.trim()}` : '';

        // 解压状态诊断
        const runtimeEntry = path.join(SERVER_RUNTIME_DIR, 'server', 'src', 'index.js');
        const nmExpress = path.join(SERVER_RUNTIME_DIR, 'node_modules', 'express');
        const extractionDiag =
          `\n解压目录存在: ${fs.existsSync(SERVER_RUNTIME_DIR)}` +
          `\nserver/index.js 存在: ${fs.existsSync(runtimeEntry)}` +
          `\nnode_modules/express 存在: ${fs.existsSync(nmExpress)}`;

        return reject(new Error(
          `后端启动超时（${timeoutMs / 1000}秒）。` +
          `子进程${reallyDead ? '已退出' : '存活'}（pid=${pid}${exitCode}）` +
          `\n启动方案: ${_activeLauncherName || '未知'}` +
          `\n入口路径: ${_activeEntryPath || SERVER_ENTRY}` +
          extractionDiag +
          stderrHint
        ));
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f1115',
    show: false,
    title: 'MV 自动生成工坊',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // 先显示本地加载页
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外链用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 后端就绪后跳转到应用
  waitForServer()
    .then(() => mainWindow.loadURL(`http://127.0.0.1:${PORT}`))
    .catch((e) => {
      dialog.showErrorBox('启动失败', `内置后端未能启动：${e.message}\n\n` +
        `如果显示「解压目录不存在」或「node_modules/express 不存在」，说明 asar 解压失败。\n` +
        `如果「启动方案=fork」但子进程已退出，说明 fork 本身能通过但后端代码报错了。\n\n` +
        `请将此截图反馈给开发者。`);
    });
}

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // 隐藏默认菜单栏
    ensureEnvFile();
    startServer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

function killServer() {
  // 关闭常规子进程
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch { /* ignore */ }
    serverProc = null;
  }
  // 关闭 detached 启动的进程引用
  if (_serverProcRef && !_serverProcRef.killed) {
    try { _serverProcRef.kill(); } catch { /* ignore */ }
    _serverProcRef = null;
  }
}

app.on('window-all-closed', () => {
  killServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', killServer);
app.on('quit', killServer);
