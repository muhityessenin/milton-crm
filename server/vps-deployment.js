"use strict";

const crypto = require("node:crypto");
const { Client } = require("ssh2");

const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DEFAULT_LOG_BYTES = 120_000;

class DeploymentError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = "DeploymentError";
    this.statusCode = statusCode;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function loadDeploymentConfig(env = process.env) {
  const port = Number(env.VPS_DEPLOY_PORT || 22);
  const config = {
    host: String(env.VPS_DEPLOY_HOST || "").trim(),
    port,
    username: String(env.VPS_DEPLOY_USER || "").trim(),
    password: String(env.VPS_DEPLOY_PASSWORD || ""),
    hostFingerprint: String(env.VPS_DEPLOY_HOST_FINGERPRINT || "").trim(),
    deployPath: String(env.VPS_DEPLOY_PATH || "/opt/milton-crm").trim(),
    jobDirectory: String(env.VPS_DEPLOY_JOB_DIR || "/tmp/milton-crm-deployments").trim(),
    historyFile: String(env.VPS_DEPLOY_HISTORY_FILE || `${String(env.VPS_DEPLOY_PATH || "/opt/milton-crm").trim()}/.deployment-state/successful.tsv`).trim(),
  };
  const missing = [];
  if (!config.host) missing.push("VPS_DEPLOY_HOST");
  if (!config.username) missing.push("VPS_DEPLOY_USER");
  if (!config.password) missing.push("VPS_DEPLOY_PASSWORD");
  if (!config.hostFingerprint) missing.push("VPS_DEPLOY_HOST_FINGERPRINT");
  if (!Number.isInteger(port) || port < 1 || port > 65535) missing.push("VPS_DEPLOY_PORT");
  if (!config.deployPath.startsWith("/") || /[\r\n\0]/.test(config.deployPath)) missing.push("VPS_DEPLOY_PATH");
  if (!config.jobDirectory.startsWith("/") || /[\r\n\0]/.test(config.jobDirectory)) missing.push("VPS_DEPLOY_JOB_DIR");
  if (!config.historyFile.startsWith("/") || /[\r\n\0]/.test(config.historyFile)) missing.push("VPS_DEPLOY_HISTORY_FILE");
  return { config, missing: [...new Set(missing)] };
}

function fingerprintForHostKey(key) {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function appendTail(current, chunk, limit = DEFAULT_LOG_BYTES) {
  const next = current + chunk.toString("utf8");
  return next.length > limit ? next.slice(-limit) : next;
}

function executeSsh(config, command, options = {}) {
  const timeoutMs = options.timeoutMs || 15_000;
  const outputLimit = options.outputLimit || DEFAULT_LOG_BYTES;
  return new Promise((resolve, reject) => {
    const connection = new Client();
    let stdout = "", stderr = "", settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.end();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new DeploymentError("VPS не ответил вовремя")), timeoutMs);
    connection.on("ready", () => {
      connection.exec(command, (error, stream) => {
        if (error) return finish(new DeploymentError(`Не удалось выполнить команду на VPS: ${error.message}`));
        stream.on("data", (chunk) => { stdout = appendTail(stdout, chunk, outputLimit); });
        stream.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk, outputLimit); });
        stream.on("close", (code, signal) => finish(null, { code:code ?? 0, signal:signal || null, stdout, stderr }));
      });
    });
    connection.on("error", (error) => finish(new DeploymentError(`SSH-подключение не удалось: ${error.message}`)));
    connection.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: timeoutMs,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 2,
      algorithms: { serverHostKey:["ssh-ed25519"] },
      hostVerifier: (key) => fingerprintForHostKey(key) === config.hostFingerprint,
    });
  });
}

function jobPaths(config, jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) throw new DeploymentError("Некорректный идентификатор публикации", 400);
  return {
    log: `${config.jobDirectory}/${jobId}.log`,
    status: `${config.jobDirectory}/${jobId}.status`,
    lock: `${config.jobDirectory}/deploy.lock`,
  };
}

function validateCommit(commit) {
  if (commit === null || commit === undefined || commit === "") return null;
  const normalized = String(commit).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) throw new DeploymentError("Некорректный SHA коммита", 400);
  return normalized;
}

function validateDeploymentVersion(version) {
  if (version === null || version === undefined || version === "") return null;
  const normalized = Number(version);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new DeploymentError("Некорректный номер версии", 400);
  return normalized;
}

function buildListDeploymentsCommand(config) {
  return [
    `cd ${shellQuote(config.deployPath)}`,
    `history=${shellQuote(config.historyFile)}`,
    "if [ ! -s \"$history\" ]; then",
    "  install -d -m 700 \"$(dirname \"$history\")\"",
    "  current_commit=$(git rev-parse HEAD)",
    "  container_id=$(docker compose --env-file .env.production -f compose.yaml ps -q app 2>/dev/null || true)",
    "  deployed_at=$(docker inspect --format '{{.State.StartedAt}}' \"$container_id\" 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')",
    "  printf '1\\t%s\\t%s\\n' \"$deployed_at\" \"$current_commit\" > \"$history\"",
    "  printf '1\\n' > \"$(dirname \"$history\")/last-version\"",
    "  chmod 600 \"$history\" \"$(dirname \"$history\")/last-version\"",
    "fi",
    "cutoff=$(date -u -d '30 days ago' +%s)",
    "tac \"$history\" | while IFS=\"$(printf '\\t')\" read -r version deployed_at commit; do",
    "  deployed_epoch=$(date -u -d \"$deployed_at\" +%s 2>/dev/null || printf '0')",
    "  [ \"$deployed_epoch\" -ge \"$cutoff\" ] || continue",
    "  if git cat-file -e \"$commit^{commit}\" 2>/dev/null; then",
    "    printf '%s\\x1f%s\\x1f%s\\x1f' \"$version\" \"$deployed_at\" \"$commit\"",
    "    git show -s --format='%cI%x1f%an%x1f%s%x1e' \"$commit\"",
    "  fi",
    "done",
  ].join("\n");
}

function parseDeploymentsOutput(raw) {
  return String(raw || "").split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [versionRaw, deployedAt, sha, committedAt, author, ...subjectParts] = record.split("\x1f");
    const version=validateDeploymentVersion(versionRaw);
    if (!version || !COMMIT_PATTERN.test(sha || "") || !deployedAt || !committedAt || !author || !subjectParts.length) {
      throw new DeploymentError("VPS вернул некорректный список версий");
    }
    return { version, deployedAt, sha, shortSha:sha.slice(0, 7), committedAt, author, subject:subjectParts.join("\x1f") };
  });
}

function buildResolveDeploymentCommand(config, version) {
  const selectedVersion=validateDeploymentVersion(version);
  return [
    `history=${shellQuote(config.historyFile)}`,
    "[ -f \"$history\" ] || exit 44",
    `record=$(awk -F '\\t' -v wanted=${selectedVersion} '$1 == wanted { found = $0 } END { if (found) print found }' "$history")`,
    "[ -n \"$record\" ] || exit 44",
    "deployed_at=$(printf '%s\\n' \"$record\" | cut -f2)",
    "commit=$(printf '%s\\n' \"$record\" | cut -f3)",
    "cutoff=$(date -u -d '30 days ago' +%s)",
    "deployed_epoch=$(date -u -d \"$deployed_at\" +%s 2>/dev/null || printf '0')",
    "[ \"$deployed_epoch\" -ge \"$cutoff\" ] || exit 45",
    `cd ${shellQuote(config.deployPath)}`,
    "git cat-file -e \"$commit^{commit}\" 2>/dev/null || exit 46",
    "printf '%s\\n' \"$commit\"",
  ].join("\n");
}

function buildStartCommand(config, jobId, commit = null, version = null) {
  const files = jobPaths(config, jobId);
  const selectedCommit = validateCommit(commit);
  const selectedVersion = validateDeploymentVersion(version);
  if (selectedVersion && !selectedCommit) throw new DeploymentError("Для версии не указан SHA коммита", 400);
  const historyDirectory=config.historyFile.slice(0,config.historyFile.lastIndexOf("/")) || "/";
  const historyEnvironment=`DEPLOY_HISTORY_DIR=${shellQuote(historyDirectory)}`;
  const deployCommand = selectedCommit
    ? `${historyEnvironment} DEPLOY_VERSION=${selectedVersion || ""} DEPLOY_COMMIT=${selectedCommit} COMPOSE_FILE=compose.yaml ./deploy.sh`
    : `${historyEnvironment} COMPOSE_FILE=compose.yaml ./deploy.sh`;
  const jobScript = [
    `exec 9>${shellQuote(files.lock)}`,
    `if ! flock -n 9; then echo "Другой деплой уже выполняется"; printf 'failed:75\\n' > ${shellQuote(files.status)}; exit 75; fi`,
    `cd ${shellQuote(config.deployPath)}`,
    deployCommand,
    "code=$?",
    `if [ "$code" -eq 0 ]; then printf 'success:0\\n' > ${shellQuote(files.status)}; else printf 'failed:%s\\n' "$code" > ${shellQuote(files.status)}; fi`,
    "exit \"$code\"",
  ].join("\n");
  return [
    `install -d -m 700 ${shellQuote(config.jobDirectory)}`,
    `printf 'running\\n' > ${shellQuote(files.status)}`,
    `: > ${shellQuote(files.log)}`,
    `nohup sh -c ${shellQuote(jobScript)} > ${shellQuote(files.log)} 2>&1 < /dev/null &`,
    "printf 'started\\n'",
  ].join("\n");
}

function buildStatusCommand(config, jobId) {
  const files = jobPaths(config, jobId);
  return [
    `if [ ! -f ${shellQuote(files.status)} ]; then printf 'missing\\n'; exit 0; fi`,
    `cat ${shellQuote(files.status)}`,
    "printf '__MILTON_DEPLOY_LOG__\\n'",
    `if [ -f ${shellQuote(files.log)} ]; then tail -c ${DEFAULT_LOG_BYTES} ${shellQuote(files.log)}; fi`,
  ].join("\n");
}

function parseStatusOutput(jobId, raw) {
  const marker = "__MILTON_DEPLOY_LOG__\n";
  const markerIndex = raw.indexOf(marker);
  const statusLine = (markerIndex < 0 ? raw : raw.slice(0, markerIndex)).trim();
  const output = markerIndex < 0 ? "" : raw.slice(markerIndex + marker.length);
  if (statusLine === "missing") throw new DeploymentError("Публикация не найдена на VPS", 404);
  const [state, code] = statusLine.split(":");
  if (!["running", "success", "failed"].includes(state)) throw new DeploymentError("VPS вернул некорректный статус публикации");
  return { jobId, state, exitCode:code === undefined ? null : Number(code), output };
}

function createVpsDeploymentService(options = {}) {
  const env = options.env || process.env;
  const executor = options.executor || executeSsh;
  const settings = () => loadDeploymentConfig(env);
  const readyConfig = () => {
    const { config, missing } = settings();
    if (missing.length) throw new DeploymentError(`Заполните переменные окружения: ${missing.join(", ")}`, 503);
    return config;
  };
  return {
    describe() {
      const { config, missing } = settings();
      return { configured:missing.length === 0, missing, host:config.host || null, port:config.port, username:config.username || null, deployPath:config.deployPath };
    },
    async listDeployments() {
      const config=readyConfig(),result=await executor(config,buildListDeploymentsCommand(config));
      if(result.code!==0)throw new DeploymentError(result.stderr.trim()||result.stdout.trim()||"Не удалось получить список версий");
      return {retentionDays:30,deployments:parseDeploymentsOutput(result.stdout)};
    },
    async start(version = null) {
      const config = readyConfig(),jobId=crypto.randomBytes(16).toString("hex");
      const selectedVersion=validateDeploymentVersion(version);let selectedCommit=null;
      if(selectedVersion){
        const resolved=await executor(config,buildResolveDeploymentCommand(config,selectedVersion));
        if(resolved.code===44)throw new DeploymentError("Версия не найдена",404);
        if(resolved.code===45)throw new DeploymentError("Версия старше 30 дней и больше недоступна",410);
        if(resolved.code!==0)throw new DeploymentError(resolved.stderr.trim()||"Коммит выбранной версии недоступен на VPS");
        selectedCommit=validateCommit(resolved.stdout.trim());
      }
      const result=await executor(config,buildStartCommand(config,jobId,selectedCommit,selectedVersion));
      if(result.code!==0||!result.stdout.includes("started"))throw new DeploymentError(result.stderr.trim()||result.stdout.trim()||"VPS не подтвердил запуск публикации");
      return {jobId,state:"running",version:selectedVersion,commit:selectedCommit};
    },
    async status(jobId) {
      const config=readyConfig(),result=await executor(config,buildStatusCommand(config,jobId));
      if(result.code!==0)throw new DeploymentError(result.stderr.trim()||"Не удалось получить статус публикации");
      return parseStatusOutput(jobId,result.stdout);
    },
  };
}

module.exports = { DeploymentError, createVpsDeploymentService, loadDeploymentConfig, fingerprintForHostKey, buildListDeploymentsCommand, parseDeploymentsOutput, buildResolveDeploymentCommand, buildStartCommand, buildStatusCommand, parseStatusOutput, validateCommit, validateDeploymentVersion };
