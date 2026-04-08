#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { setTimeout: sleep } = require("node:timers/promises");

let puppeteer;
let StealthPlugin;
try {
  puppeteer = require("puppeteer-extra");
  StealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteer.use(StealthPlugin());
} catch {
  try {
    puppeteer = require("puppeteer");
  } catch {
    puppeteer = null;
  }
}

const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_ACCOUNTS_FILE = "accounts.json";
const DEFAULT_TOKENS_FILE = "tokens.json";

// ============================================================================
// ONE-DIRECTIONAL RING STRATEGY (Parallel Execution)
// ============================================================================
// Pattern: Fixed ring direction, all accounts send in parallel
// - Round N: A→B, B→C, C→D, D→A (semua bersamaan)
// - Round N+1: sama, A→B, B→C, C→D, D→A (semua bersamaan)
// 
// Benefits:
// - NO reciprocal pairs dalam round yang sama (A→B tidak konflik dengan B→C)
// - Parallel execution = lebih cepat
// - Predictable, tidak perlu tracking cooldown pairs
// ============================================================================

/**
 * Get recipient untuk sender dalam one-directional ring
 * Sender di index i akan kirim ke index (i+1) % N
 * 
 * @param {string} senderName - Nama akun sender
 * @param {Array} sortedAccounts - Array akun yang sudah di-sort by name
 * @returns {Object|null} Recipient account atau null jika tidak ditemukan
 */
function getRingRecipient(senderName, sortedAccounts) {
  if (!Array.isArray(sortedAccounts) || sortedAccounts.length < 2) {
    return null;
  }

  const senderIndex = sortedAccounts.findIndex((acc) => acc.name === senderName);
  if (senderIndex === -1) {
    return null;
  }

  // Always send to next account in ring (index + 1, wrapping around)
  const recipientIndex = (senderIndex + 1) % sortedAccounts.length;
  return sortedAccounts[recipientIndex];
}

/**
 * Build a single internal send request using one-directional ring strategy
 * This replaces the old buildInternalSendRequests (plural) function
 * 
 * @param {Array} accounts - All accounts array
 * @param {string} senderName - Name of sender account
 * @param {Object} sendPolicy - Send policy with randomAmount config
 * @returns {Object|null} Single send request or null if cannot send
 */
function buildInternalSendRequest(accounts, senderName, sendPolicy) {
  // Filter accounts with valid addresses
  const validAccounts = accounts.filter(
    (acc) => String(acc.address || "").trim()
  );

  if (validAccounts.length < 2) {
    console.log(
      `[ring] Internal mode requires at least 2 accounts with valid addresses. ` +
      `Found ${validAccounts.length} valid accounts.`
    );
    return null;
  }

  // Sort accounts by name for consistent ring order (no shuffle!)
  const sortedAccounts = [...validAccounts].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  // Get recipient using ring strategy
  const recipient = getRingRecipient(senderName, sortedAccounts);
  if (!recipient) {
    console.log(`[ring] No recipient found for ${senderName}`);
    return null;
  }

  const amount = generateRandomCcAmount(sendPolicy.randomAmount);

  console.log(`[ring] ${senderName} -> ${recipient.name} (${amount} CC)`);

  return {
    amount,
    label: recipient.name,
    address: recipient.address,
    source: "internal-ring"
  };
}

// ============================================================================
// LEGACY PAIR TRACKING (Stub functions - ring strategy doesn't need these)
// ============================================================================
// These are kept for backward compatibility during transition
// Ring strategy is one-directional, so no reciprocal pairs occur

const SEND_PAIR_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes (legacy reference)
const sendPairHistory = new Map(); // Empty map for legacy references

function recordSendPair(senderName, recipientName) {
  // No-op: Ring strategy doesn't need pair tracking
  // Kept for backward compatibility with executeSendBatch
}

function isReciprocalPairInCooldown(senderName, recipientName) {
  // Always return false: Ring strategy avoids reciprocal pairs by design
  return false;
}

function cleanupExpiredSendPairs() {
  // No-op: Ring strategy doesn't use pair tracking
  sendPairHistory.clear();
}

function getShortestReciprocalCooldownSeconds(senderName, sortedAccounts) {
  // Always return 0: Ring strategy doesn't have reciprocal cooldowns
  return 0;
}

// ============================================================================
// ROUND ROBIN OFFSET (Legacy - kept for backward compatibility)
// ============================================================================
// These functions track round offsets but are not essential for ring strategy
// Ring strategy uses fixed offset of 1 (next account in sorted list)

let roundRobinOffset = 0;

function getRoundRobinOffset() {
  return roundRobinOffset;
}

function getRotatingOffset(totalAccounts) {
  // Ring strategy always uses offset 1 (next in line)
  // This function is kept for backward compatibility
  return 1;
}

function incrementRoundRobinOffset() {
  roundRobinOffset += 1;
}

function resetRoundRobinOffset() {
  roundRobinOffset = 0;
}

// ============================================================================

// Global TX Tracking - accumulates totals across all accounts for dashboard banner
let globalSwapsTotal = 0;
let globalSwapsOk = 0;
let globalSwapsFail = 0;

// Per-account TX tracking - accumulates totals per account for TX Progress column
const perAccountTxStats = {};

function resetGlobalTxStats() {
  globalSwapsTotal = 0;
  globalSwapsOk = 0;
  globalSwapsFail = 0;
  // Clear per-account stats
  for (const key of Object.keys(perAccountTxStats)) {
    delete perAccountTxStats[key];
  }
}

function addGlobalTxStats(completed, failed) {
  globalSwapsTotal += completed + failed;
  globalSwapsOk += completed;
  globalSwapsFail += failed;
}

function addPerAccountTxStats(accountName, completed, failed) {
  if (!perAccountTxStats[accountName]) {
    perAccountTxStats[accountName] = { total: 0, ok: 0, fail: 0 };
  }
  perAccountTxStats[accountName].total += completed + failed;
  perAccountTxStats[accountName].ok += completed;
  perAccountTxStats[accountName].fail += failed;
}

function getPerAccountTxStats(accountName) {
  return perAccountTxStats[accountName] || { total: 0, ok: 0, fail: 0 };
}

const INTERNAL_API_DEFAULTS = {
  baseUrl: "https://bridge.rootsfi.com",
  paths: {
    onboard: "/onboard",
    send: "/send",
    bridge: "/bridge",
    rewards: "/rewards",
    syncAccount: "/api/auth/sync-account",
    authPending: "/api/auth/pending",
    sendOtp: "/api/auth/email/send-otp",
    verifyOtp: "/api/auth/email/verify-otp",
    finalizeReturning: "/api/auth/finalize-returning",
    walletBalances: "/api/wallet/balances",
    sendCcCooldown: "/api/send/cc-cooldown",
    sendResolve: "/api/send/resolve",
    sendTransfer: "/api/send/transfer",
    sendHistory: "/api/send/history",
    walletCcOutgoing: "/api/wallet/cc-outgoing",
    rewardsLottery: "/api/rewards/lottery",
    rewardsSendLoyaltyDailyTaper: "/api/rewards/send-loyalty-daily-taper"
  },
  headers: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    acceptLanguage: "en-US,en;q=0.9,id;q=0.8",
    sendBrowserClientHints: true,
    secChUa: '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    secChUaMobile: "?0",
    secChUaPlatform: '"macOS"',
    secFetchDest: "empty",
    secFetchMode: "cors",
    secFetchSite: "same-origin",
    priority: "u=1, i"
  },
  http: {
    timeoutMs: 30000,
    maxRetries: 2,
    retryBaseDelayMs: 800
  },
  requestPacing: {
    minDelayMs: 450,
    jitterMs: 250
  },
  send: {
    maxLoopTx: 1,
    minDelayTxSeconds: 120,
    maxDelayTxSeconds: 120,
    delayCycleSeconds: 300,
    randomAmount: {
      enabled: false,
      min: "0.10",
      max: "0.50",
      decimals: 2
    }
  },
  ui: {
    dashboard: true,
    logLines: 12
  }
};

function getTimeStamp() {
  return new Date().toISOString().slice(11, 19);
}

class PinnedDashboard {
  constructor({ enabled, logLines, accountSnapshots }) {
    this.enabled = Boolean(enabled && process.stdout.isTTY);
    this.logLines = Math.max(1, clampToNonNegativeInt(logLines, INTERNAL_API_DEFAULTS.ui.logLines));
    this.logs = [];
    this.accountSnapshots = isObject(accountSnapshots) ? accountSnapshots : {};
    this.state = {
      phase: "init",
      selectedAccount: "-",
      accounts: "-",
      cookie: "-",
      balance: "-",
      send: "-",
      transfer: "-",
      reward: "-",
      mode: "BALANCE",
      strategy: "balanced_human",
      swapsTotal: 0,
      swapsOk: 0,
      swapsFail: 0,
      targetPerDay: 0,
      cooldown: "0/0"
    };
    this.originalConsole = null;
  }

  attach() {
    if (!this.enabled || this.originalConsole) {
      return;
    }

    this.originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error
    };

    console.log = (...args) => this.pushLog("INFO", args);
    console.warn = (...args) => this.pushLog("WARN", args);
    console.error = (...args) => this.pushLog("ERROR", args);
    this.render();
  }

  detach() {
    if (!this.originalConsole) {
      return;
    }

    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.originalConsole = null;
    process.stdout.write("\n");
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.syncSelectedAccountSnapshot();
    this.render();
  }

  stringifyArg(value) {
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  pushLog(level, args) {
    let message = args.map((item) => this.stringifyArg(item)).join(" ").trim();
    let logLevel = level;

    const accountTagMatch = message.match(/^\[(A\d+\/\d+)\]\s*/i);
    if (accountTagMatch) {
      logLevel = String(accountTagMatch[1] || level).toUpperCase();
      message = message.slice(accountTagMatch[0].length).trim();
    }

    this.logs.push({
      time: getTimeStamp(),
      level: logLevel,
      message
    });

    if (this.logs.length > this.logLines) {
      this.logs.splice(0, this.logs.length - this.logLines);
    }

    this.render();
  }

  clip(text, maxLength) {
    const value = String(text || "");
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  formatCell(text, width) {
    const value = this.clip(String(text || "-"), width);
    return value.padEnd(width, " ");
  }

  parseSelectedAccountName() {
    const raw = String(this.state.selectedAccount || "").trim();
    const indexPrefix = raw.match(/^\[\d+\/\d+\]\s*(.+)$/);
    const value = indexPrefix ? indexPrefix[1] : raw;
    const open = value.indexOf(" (");
    if (open > 0) {
      return value.slice(0, open).trim();
    }
    return value;
  }

  mapPhaseToStatus(phase) {
    const key = String(phase || "").toLowerCase();
    const map = {
      init: "IDLE",
      preflight: "SYNC",
      "vercel-refresh": "SECURITY",
      "browser-checkpoint": "SECURITY",
      "session-reuse": "SESSION",
      "otp-send": "OTP-WAIT",
      "otp-verify": "OTP-VERIFY",
      "otp-fallback": "OTP-FALLBACK",
      "sync-onboard": "SYNC",
      "sync-bridge": "SYNC",
      "finalize-returning": "FINALIZE",
      balances: "IDLE",
      send: "SEND",
      cooldown: "COOLDOWN",
      completed: "IDLE",
      "session-reused": "IDLE",
      "dry-run": "DRY-RUN"
    };
    return map[key] || String(phase || "-").toUpperCase();
  }

  parseBalanceFields() {
    const raw = String(this.state.balance || "");
    const matchCc = raw.match(/CC=([^|]+)/i);
    return {
      cc: matchCc ? String(matchCc[1]).trim() : "-"
    };
  }

  syncSelectedAccountSnapshot() {
    const selected = this.parseSelectedAccountName();
    if (!selected || selected === "-") {
      return;
    }

    const prev = isObject(this.accountSnapshots[selected]) ? this.accountSnapshots[selected] : {};
    const balances = this.parseBalanceFields();
    const currentSend = String(this.state.send || "-").trim();
    const currentReward = String(this.state.reward || "-").trim();
    // Use per-account stats for TX Progress column (not global state)
    const accountStats = getPerAccountTxStats(selected);
    const currentProgress = `${accountStats.total} (ok:${accountStats.ok}|fail:${accountStats.fail})`;

    this.accountSnapshots[selected] = {
      status: this.mapPhaseToStatus(this.state.phase),
      cc: balances.cc !== "-" ? balances.cc : String(prev.cc || "-"),
      progress: currentProgress !== "-" ? currentProgress : String(prev.progress || "-"),
      send: currentSend !== "-" ? currentSend : String(prev.send || "-"),
      reward: currentReward !== "-" ? currentReward : String(prev.reward || "-")
    };
  }

  parseAccountRows() {
    const selected = this.parseSelectedAccountName();
    const balances = this.parseBalanceFields();
    const raw = String(this.state.accounts || "").trim();
    const chunks = raw && raw !== "-" ? raw.split("|") : [];
    const rows = [];

    for (const chunk of chunks) {
      const text = chunk.trim();
      if (!text) {
        continue;
      }

      const marked = text.startsWith("*");
      const cleaned = marked ? text.slice(1).trim() : text;
      const match = cleaned.match(/^([^\(]+)\(([^\)]+)\)$/);
      const name = match ? String(match[1]).trim() : cleaned;
      const token = match ? String(match[2]).trim() : "-";
      const isSelected = name === selected || (marked && selected === "-");
      const snapshot = isObject(this.accountSnapshots[name]) ? this.accountSnapshots[name] : {};
      // Use per-account stats for TX Progress column (not global state)
      const accountStats = getPerAccountTxStats(name);
      const currentProgress = `${accountStats.total} (ok:${accountStats.ok}|fail:${accountStats.fail})`;

      rows.push({
        name,
        status: isSelected
          ? this.mapPhaseToStatus(this.state.phase)
          : (snapshot.status || (token && token !== "-" ? String(token).toUpperCase() : "IDLE")),
        token,
        active: isSelected,
        cc: isSelected
          ? (balances.cc !== "-" ? balances.cc : String(snapshot.cc || "-"))
          : String(snapshot.cc || "-"),
        progress: isSelected ? currentProgress : String(snapshot.progress || "-"),
        send: isSelected
          ? (String(this.state.send || "-") !== "-" ? String(this.state.send || "-") : String(snapshot.send || "-"))
          : String(snapshot.send || "-"),
        reward: isSelected
          ? (String(this.state.reward || "-") !== "-" ? String(this.state.reward || "-") : String(snapshot.reward || "-"))
          : String(snapshot.reward || "-")
      });
    }

    if (rows.length === 0 && selected && selected !== "-") {
      const snapshot = isObject(this.accountSnapshots[selected]) ? this.accountSnapshots[selected] : {};
      // Use per-account stats for TX Progress column (not global state)
      const accountStats = getPerAccountTxStats(selected);
      const currentProgress = `${accountStats.total} (ok:${accountStats.ok}|fail:${accountStats.fail})`;
      rows.push({
        name: selected,
        status: this.mapPhaseToStatus(this.state.phase),
        token: "-",
        active: true,
        cc: balances.cc !== "-" ? balances.cc : String(snapshot.cc || "-"),
        progress: currentProgress,
        send: String(this.state.send || "-") !== "-" ? String(this.state.send || "-") : String(snapshot.send || "-"),
        reward: String(this.state.reward || "-") !== "-" ? String(this.state.reward || "-") : String(snapshot.reward || "-")
      });
    }

    return rows;
  }

  render() {
    if (!this.enabled) {
      return;
    }

    const now = new Date().toLocaleString("id-ID", {
      hour12: false,
      timeZone: "Asia/Jakarta"
    });
    const rows = this.parseAccountRows();
    const accountCount = rows.length;
    const terminalWidth = Number(process.stdout.columns || 132);
    const frameWidth = Math.max(118, Math.min(170, terminalWidth));
    const contentWidth = frameWidth - 4;
    const modeLabel = String(this.state.mode || "-").toUpperCase();
    const topBorder = `+${"=".repeat(frameWidth - 2)}+`;
    const midBorder = `+${"-".repeat(frameWidth - 2)}+`;
    const bannerLine = (text) => `| ${this.formatCell(text, contentWidth)} |`;

    const columnCount = 6;
    const separatorWidth = 3 * (columnCount - 1);
    const accountWidth = 14;
    const statusWidth = 9;
    const ccWidth = 10;
    const txProgressWidth = 20;
    const rewardWidth = 22;
    const sendPlanWidth = Math.max(
      24,
      contentWidth - separatorWidth - (accountWidth + statusWidth + ccWidth + txProgressWidth + rewardWidth)
    );
    const tableWidths = [accountWidth, statusWidth, ccWidth, txProgressWidth, sendPlanWidth, rewardWidth];
    const tableRow = (cells) => `| ${cells.map((cell, idx) => this.formatCell(cell, tableWidths[idx])).join(" | ")} |`;
    const tableRule = (char) => `| ${tableWidths.map((width) => char.repeat(width)).join(" | ")} |`;

    const lines = [];
    lines.push(topBorder);
    lines.push(
      bannerLine(
        `RootFiBot Auto-Send V1  |  ${now} WIB  |  ${accountCount} akun  |  Mode: ${modeLabel}`
      )
    );
    lines.push(
      bannerLine(
        `Sends: ${this.state.swapsTotal} total  ${this.state.swapsOk} ok  ${this.state.swapsFail} fail  |  Target: ${this.state.targetPerDay}/day`
      )
    );
    lines.push(
      bannerLine(
        `State: ${this.state.phase}`
      )
    );
    lines.push(midBorder);
    lines.push(tableRow(["Akun", "Status", "CC", "TX Progress", "Send Plan", "This Week Reward"]));
    lines.push(tableRule("-"));

    if (rows.length === 0) {
      lines.push(tableRow(["-", "IDLE", "-", "-", "-", "-"]));
    } else {
      for (const row of rows) {
        const progressLabel = String(row.progress || "-");
        const sendLabel = String(row.send || "-");
        const rewardLabel = String(row.reward || "-");
        lines.push(tableRow([row.name, row.status, row.cc, progressLabel, sendLabel, rewardLabel]));
      }
    }

    lines.push(midBorder);
    lines.push("");
    lines.push(`--- Execution Logs (last ${this.logLines}) ---`);

    if (this.logs.length === 0) {
      lines.push("[--:--:--] INFO  (no logs yet)");
    } else {
      const logMessageWidth = Math.max(48, frameWidth - 24);
      for (const log of this.logs) {
        lines.push(`[${log.time}] ${log.level.padEnd(5)} ${this.clip(log.message, logMessageWidth)}`);
      }
    }

    lines.push("");
    lines.push("Ctrl+C to stop  |  Round delay: config.send.delayCycleSeconds");

    process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampToNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function randomIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function shuffleArray(items) {
  const array = Array.isArray(items) ? [...items] : [];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = randomIntInclusive(0, i);
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

function withAccountTag(accountLogTag, message) {
  if (!accountLogTag) {
    return message;
  }
  return `[${accountLogTag}] ${message}`;
}

function maskSecret(value, head = 4, tail = 4) {
  const text = String(value || "");
  if (!text) {
    return "<empty>";
  }
  if (text.length <= head + tail) {
    return "*".repeat(text.length);
  }
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function maskEmail(email) {
  const value = String(email || "").trim();
  if (!value.includes("@")) {
    return maskSecret(value, 2, 2);
  }

  const [local, domain] = value.split("@");
  const localMasked = local.length <= 2 ? `${local[0] || "*"}*` : `${local.slice(0, 2)}***${local.slice(-1)}`;
  return `${localMasked}@${domain}`;
}

function parseArgs(argv) {
  const args = {
    configFile: DEFAULT_CONFIG_FILE,
    accountsFile: DEFAULT_ACCOUNTS_FILE,
    tokensFile: DEFAULT_TOKENS_FILE,
    accountName: null,
    sendCcAmount: null,
    sendTo: null,
    sendIdempotencyKey: null,
    dryRun: false,
    noDashboard: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--no-dashboard") {
      args.noDashboard = true;
      continue;
    }

    if (token.startsWith("--config=")) {
      args.configFile = token.slice("--config=".length).trim();
      continue;
    }

    if (token === "--config") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --config");
      }
      args.configFile = argv[i + 1].trim();
      i += 1;
      continue;
    }

    if (token.startsWith("--accounts=")) {
      args.accountsFile = token.slice("--accounts=".length).trim();
      continue;
    }

    if (token === "--accounts") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --accounts");
      }
      args.accountsFile = argv[i + 1].trim();
      i += 1;
      continue;
    }

    if (token.startsWith("--tokens=")) {
      args.tokensFile = token.slice("--tokens=".length).trim();
      continue;
    }

    if (token === "--tokens") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --tokens");
      }
      args.tokensFile = argv[i + 1].trim();
      i += 1;
      continue;
    }

    if (token.startsWith("--account=")) {
      args.accountName = token.slice("--account=".length).trim();
      continue;
    }

    if (token === "--account") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --account");
      }
      args.accountName = argv[i + 1].trim();
      i += 1;
      continue;
    }

    if (token.startsWith("--send-cc=")) {
      args.sendCcAmount = token.slice("--send-cc=".length).trim();
      continue;
    }

    if (token === "--send-cc") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --send-cc");
      }
      args.sendCcAmount = argv[i + 1].trim();
      i += 1;
      continue;
    }

    if (token.startsWith("--send-to=")) {
      args.sendTo = token.slice("--send-to=".length).trim();
      continue;
    }

    if (token === "--send-to") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --send-to");
      }
      args.sendTo = argv[i + 1].trim();
      i += 1;
      continue;
    }

    if (token.startsWith("--send-idempotency-key=")) {
      args.sendIdempotencyKey = token.slice("--send-idempotency-key=".length).trim();
      continue;
    }

    if (token === "--send-idempotency-key") {
      if (!argv[i + 1]) {
        throw new Error("Missing value for --send-idempotency-key");
      }
      args.sendIdempotencyKey = argv[i + 1].trim();
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printHelp() {
  console.log(`RootsFi API Login + Balance Bot (API-only)

Usage:
  node index.js [options]

Options:
  --config <path>      Config file (default: config.json)
  --accounts <path>    Accounts file (default: accounts.json)
  --tokens <path>      Generated token storage (default: tokens.json)
  --account <name>     Account name from accounts.json
  --send-cc <amount>   Send CC amount (example: 10.25)
  --send-to <target>   Recipient alias or canton address
  --send-idempotency-key <key>
                       Optional idempotency key for transfer request
  --no-dashboard       Disable pinned dashboard UI
  --dry-run            Validate files and print summary only
  -h, --help           Show this help

Environment overrides:
  ROOTSFI_EMAIL        Override email from accounts.json
  ROOTSFI_NO_DASHBOARD Set to 1 to disable dashboard
  ROOTSFI_SEND_CC      Send CC amount
  ROOTSFI_SEND_TO      Recipient alias or canton address
  ROOTSFI_SEND_IDEMPOTENCY_KEY
                       Transfer idempotency key override
`);
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`${label} file not found: ${filePath}`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} file ${filePath}: ${error.message}`);
  }
}

async function readOptionalJson(filePath, label) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${label} file ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function generateBrowserHeaderProfile(deviceId) {
  const chromeMajor = randomIntInclusive(143, 146);

  return {
    userAgent:
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
    acceptLanguage: INTERNAL_API_DEFAULTS.headers.acceptLanguage,
    sendBrowserClientHints: true,
    secChUa: `"Chromium";v="${chromeMajor}", "Not-A.Brand";v="24", "Google Chrome";v="${chromeMajor}"`,
    secChUaMobile: INTERNAL_API_DEFAULTS.headers.secChUaMobile,
    secChUaPlatform: INTERNAL_API_DEFAULTS.headers.secChUaPlatform,
    secFetchDest: INTERNAL_API_DEFAULTS.headers.secFetchDest,
    secFetchMode: INTERNAL_API_DEFAULTS.headers.secFetchMode,
    secFetchSite: INTERNAL_API_DEFAULTS.headers.secFetchSite,
    priority: INTERNAL_API_DEFAULTS.headers.priority,
    extra: {
      "x-device-id": deviceId
    }
  };
}

function normalizeTokenProfile(rawProfile) {
  const input = isObject(rawProfile) ? rawProfile : {};
  const deviceId = String(input.deviceId || crypto.randomUUID()).trim() || crypto.randomUUID();
  const generatedHeaders = generateBrowserHeaderProfile(deviceId);
  const headersInput = isObject(input.headers) ? input.headers : {};
  const securityInput = isObject(input.security) ? input.security : {};
  const now = new Date().toISOString();

  return {
    cookie: String(input.cookie || "").trim(),
    deviceId,
    headers: {
      ...generatedHeaders,
      ...headersInput,
      extra: {
        ...generatedHeaders.extra,
        ...(isObject(headersInput.extra) ? headersInput.extra : {}),
        "x-device-id": deviceId
      }
    },
    security: {
      strategy: "browser-challenge-cookie-reuse",
      antiBotNonce: String(securityInput.antiBotNonce || crypto.randomBytes(16).toString("hex")),
      createdAt: String(securityInput.createdAt || now),
      updatedAt: String(securityInput.updatedAt || now),
      lastVercelRefreshAt: String(securityInput.lastVercelRefreshAt || "").trim(),
      hasSecurityCookie: Boolean(securityInput.hasSecurityCookie),
      hasSessionCookie: Boolean(securityInput.hasSessionCookie),
      checkpointRefreshCount: clampToNonNegativeInt(
        securityInput.checkpointRefreshCount,
        0
      )
    }
  };
}

function normalizeTokens(rawTokens, accountsConfig) {
  const raw = isObject(rawTokens) ? rawTokens : {};
  const rawAccounts = isObject(raw.accounts) ? raw.accounts : {};
  const accountMap = {};

  for (const account of accountsConfig.accounts) {
    accountMap[account.name] = normalizeTokenProfile(rawAccounts[account.name]);
  }

  for (const [accountName, profile] of Object.entries(rawAccounts)) {
    if (!Object.prototype.hasOwnProperty.call(accountMap, accountName)) {
      accountMap[accountName] = normalizeTokenProfile(profile);
    }
  }

  return {
    version: 1,
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    accounts: accountMap
  };
}

function applyTokenProfileToConfig(config, profile) {
  const tokenHeaders = isObject(profile.headers) ? profile.headers : {};

  config.headers = {
    ...config.headers,
    ...tokenHeaders,
    extra: {
      ...(isObject(tokenHeaders.extra) ? tokenHeaders.extra : {}),
      "x-device-id": profile.deviceId
    },
    cookie: String(profile.cookie || "").trim()
  };
}

function applyClientStateToTokenProfile(profile, client, checkpointRefreshCount, lastVercelRefreshAt) {
  const nextProfile = normalizeTokenProfile(profile);
  const now = new Date().toISOString();
  const currentCookie = client.getCookieHeader();

  if (currentCookie) {
    nextProfile.cookie = currentCookie;
  }

  nextProfile.headers.extra = {
    ...(isObject(nextProfile.headers.extra) ? nextProfile.headers.extra : {}),
    "x-device-id": nextProfile.deviceId
  };

  nextProfile.security = {
    ...nextProfile.security,
    updatedAt: now,
    lastVercelRefreshAt:
      String(lastVercelRefreshAt || nextProfile.security.lastVercelRefreshAt || "").trim(),
    hasSecurityCookie: client.hasSecurityCookie(),
    hasSessionCookie: client.hasAccountSessionCookie(),
    checkpointRefreshCount:
      clampToNonNegativeInt(nextProfile.security.checkpointRefreshCount, 0) +
      clampToNonNegativeInt(checkpointRefreshCount, 0)
  };

  return nextProfile;
}

async function saveTokens(tokensPath, tokensState) {
  const payload = {
    ...tokensState,
    version: 1,
    updatedAt: new Date().toISOString()
  };

  await fs.writeFile(tokensPath, JSON.stringify(payload, null, 2), "utf8");
}

let tokensSaveQueue = Promise.resolve();

async function saveTokensSerial(tokensPath, tokensState) {
  tokensSaveQueue = tokensSaveQueue.then(() => saveTokens(tokensPath, tokensState));
  return tokensSaveQueue;
}

function cloneRuntimeConfig(config) {
  return {
    ...config,
    paths: { ...config.paths },
    headers: {
      ...config.headers,
      extra: {
        ...(isObject(config.headers && config.headers.extra) ? config.headers.extra : {})
      }
    },
    http: { ...config.http },
    requestPacing: { ...config.requestPacing },
    session: { ...config.session },
    send: {
      ...config.send,
      randomAmount: {
        ...(isObject(config.send && config.send.randomAmount) ? config.send.randomAmount : {})
      }
    },
    ui: { ...config.ui }
  };
}

async function loadRecipients(relativePath) {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  let text;

  try {
    text = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        absolutePath,
        missing: true,
        recipients: [],
        invalidLines: []
      };
    }
    throw error;
  }

  const recipients = [];
  const invalidLines = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }

    const sepIndex = raw.indexOf("::");
    if (sepIndex <= 0 || sepIndex >= raw.length - 2) {
      invalidLines.push({ line: index + 1, value: raw });
      continue;
    }

    const alias = raw.slice(0, sepIndex).trim();
    const address = raw.slice(sepIndex + 2).trim();

    if (!alias || !address) {
      invalidLines.push({ line: index + 1, value: raw });
      continue;
    }

    recipients.push({ alias, address, partyId: `${alias}::${address}` });
  }

  return {
    absolutePath,
    missing: false,
    recipients,
    invalidLines
  };
}

function getRandomRecipient(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("No recipients available for random selection");
  }
  const index = randomIntInclusive(0, recipients.length - 1);
  return recipients[index];
}

async function promptSendMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    console.log("\n=== RootsFi Bot - Send Mode ===");
    console.log("1. External Address (random dari recipient.txt)");
    console.log("2. Internal Address (ke address masing-masing akun)");
    console.log("3. Balance Only (cek saldo saja)");
    console.log("");

    const answer = await rl.question("Pilih mode [1/2/3]: ");
    const choice = answer.trim();

    if (choice === "1") {
      return "external";
    } else if (choice === "2") {
      return "internal";
    } else if (choice === "3") {
      return "balance-only";
    } else {
      console.log("[warn] Pilihan tidak valid, default ke balance-only");
      return "balance-only";
    }
  } finally {
    rl.close();
  }
}

async function promptAccountSelection(accounts) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    console.log("\n=== Pilih Akun untuk TX ===");
    console.log("0. Semua akun");
    
    for (let i = 0; i < accounts.length; i++) {
      console.log(`${i + 1}. ${accounts[i].name} (${maskEmail(accounts[i].email)})`);
    }
    console.log("");

    const answer = await rl.question(`Pilih akun [0-${accounts.length}]: `);
    const choice = answer.trim();

    if (choice === "0" || choice === "") {
      return { mode: "all", selectedAccounts: accounts };
    }

    // Check if multiple accounts selected (comma separated)
    if (choice.includes(",")) {
      const indices = choice.split(",").map(s => parseInt(s.trim(), 10));
      const selectedAccounts = [];
      
      for (const idx of indices) {
        if (idx >= 1 && idx <= accounts.length) {
          selectedAccounts.push(accounts[idx - 1]);
        }
      }

      if (selectedAccounts.length === 0) {
        console.log("[warn] Tidak ada akun valid dipilih, menggunakan semua akun");
        return { mode: "all", selectedAccounts: accounts };
      }

      return { mode: "selected", selectedAccounts };
    }

    // Single account selected
    const idx = parseInt(choice, 10);
    if (idx >= 1 && idx <= accounts.length) {
      return { mode: "single", selectedAccounts: [accounts[idx - 1]] };
    }

    console.log("[warn] Pilihan tidak valid, menggunakan semua akun");
    return { mode: "all", selectedAccounts: accounts };
  } finally {
    rl.close();
  }
}

function normalizeCcAmount(rawAmount) {
  const text = String(rawAmount || "").trim();
  if (!text) {
    throw new Error("CC amount is required");
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid CC amount format: ${text}`);
  }

  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`CC amount must be greater than zero: ${text}`);
  }

  return text;
}

function normalizeRandomAmountConfig(rawRandomAmount, fallback, pathLabel) {
  const base = isObject(fallback) ? fallback : INTERNAL_API_DEFAULTS.send.randomAmount;
  const input = isObject(rawRandomAmount) ? rawRandomAmount : {};

  const enabled =
    typeof input.enabled === "boolean"
      ? input.enabled
      : Boolean(base.enabled);

  const min = normalizeCcAmount(
    Object.prototype.hasOwnProperty.call(input, "min") ? input.min : base.min
  );
  const max = normalizeCcAmount(
    Object.prototype.hasOwnProperty.call(input, "max") ? input.max : base.max
  );
  const decimals = clampToNonNegativeInt(
    input.decimals,
    clampToNonNegativeInt(base.decimals, 2)
  );

  if (decimals > 8) {
    throw new Error(`${pathLabel}.decimals must be <= 8`);
  }

  if (Number(min) > Number(max)) {
    throw new Error(`${pathLabel}.min must be <= ${pathLabel}.max`);
  }

  return {
    enabled,
    min,
    max,
    decimals
  };
}

function generateRandomCcAmount(randomAmountConfig) {
  const decimals = clampToNonNegativeInt(randomAmountConfig.decimals, 2);
  const factor = Math.pow(10, decimals);
  const minUnits = Math.ceil(Number(randomAmountConfig.min) * factor);
  const maxUnits = Math.floor(Number(randomAmountConfig.max) * factor);

  if (minUnits <= 0 || maxUnits <= 0 || minUnits > maxUnits) {
    throw new Error("Random amount range is invalid. Check config.send.randomAmount settings.");
  }

  const units = randomIntInclusive(minUnits, maxUnits);
  const amount = (units / factor).toFixed(decimals);
  return normalizeCcAmount(amount);
}

function buildSendRequestsWithRandomRecipients(recipients, sendPolicy) {
  const requests = [];
  const txCount = clampToNonNegativeInt(sendPolicy.maxLoopTx || sendPolicy.maxTx, 1);

  for (let index = 0; index < txCount; index += 1) {
    const amount = generateRandomCcAmount(sendPolicy.randomAmount);
    const target = getRandomRecipient(recipients);

    requests.push({
      amount,
      label: target.alias,
      address: target.partyId,
      source: "external-random"
    });
  }

  return requests;
}

// Build internal recipients from accounts.json (exclude self)
function buildInternalRecipients(accounts, currentAccountName) {
  const recipients = [];
  
  for (const account of accounts) {
    // Skip self
    if (account.name === currentAccountName) {
      continue;
    }
    
    // Skip accounts without address
    const address = String(account.address || "").trim();
    if (!address) {
      continue;
    }
    
    recipients.push({
      alias: account.name,
      address: address,
      partyId: address // For internal, address IS the full cantonPartyId
    });
  }
  
  return recipients;
}

function buildSendRequests(target, sendPolicy, fixedAmountInput, idempotencySeed) {
  const requests = [];
  const txCount = clampToNonNegativeInt(sendPolicy.maxLoopTx || sendPolicy.maxTx, 1);

  for (let index = 0; index < txCount; index += 1) {
    const amount = fixedAmountInput
      ? normalizeCcAmount(fixedAmountInput)
      : generateRandomCcAmount(sendPolicy.randomAmount);

    let idempotencyKey = null;
    if (idempotencySeed) {
      idempotencyKey = txCount === 1 ? idempotencySeed : `${idempotencySeed}-${index + 1}`;
    }

    requests.push({
      amount,
      label: target.label,
      address: target.address,
      source: target.source,
      idempotencyKey
    });
  }

  return requests;
}

function shouldRefreshVercelCookie(lastRefreshAt, refreshEveryMinutes) {
  const minutes = clampToNonNegativeInt(refreshEveryMinutes, 0);
  if (minutes <= 0) {
    return false;
  }

  const parsed = Date.parse(String(lastRefreshAt || "").trim());
  if (!Number.isFinite(parsed)) {
    return true;
  }

  const ageMs = Date.now() - parsed;
  return ageMs >= minutes * 60 * 1000;
}

function resolveSendRecipientTarget(input, recipients) {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("Recipient target is required for send mode");
  }

  if (value.includes("::")) {
    return {
      label: value,
      address: value,
      source: "direct"
    };
  }

  const found = recipients.find((entry) => entry.alias === value);
  if (!found) {
    throw new Error(`Recipient alias '${value}' not found in recipient file`);
  }

  const resolvedPartyId = String(
    found.partyId ||
      (String(found.address || "").includes("::") ? found.address : `${found.alias}::${found.address}`)
  ).trim();

  return {
    label: found.alias,
    address: resolvedPartyId,
    source: "alias"
  };
}

function isVercelCheckpointError(error) {
  const message = String(error && error.message ? error.message : error || "");
  return message.includes("Vercel Security Checkpoint");
}

function isSessionReuseTimeoutError(error) {
  const status = Number(error && error.status);
  if (Number.isFinite(status)) {
    return false;
  }

  const message = String(error && error.message ? error.message : error || "").toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function isInvalidSessionError(error) {
  const status = Number(error && error.status);
  if (status === 401 || status === 403) {
    return true;
  }

  const message = String(error && error.message ? error.message : error || "").toLowerCase();
  return (
    message.includes("invalid session") ||
    message.includes("session expired") ||
    message.includes("no active session") ||
    message.includes("not authenticated") ||
    message.includes("unauthorized") ||
    message.includes("authentication required")
  );
}

function isTimeoutError(error) {
  if (!error) {
    return false;
  }

  const message = String(
    error && error.message ? error.message : error || ""
  ).toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("request timed out")
  );
}

function isSendEligibilityDelayError(error) {
  const status = Number(error && error.status);
  if (status === 409 || status === 423) {
    return true;
  }

  const message = String(error && error.message ? error.message : error || "").toLowerCase();
  return (
    message.includes("cooldown") ||
    message.includes("retry after") ||
    message.includes("too soon") ||
    message.includes("wait before") ||
    message.includes("temporarily unavailable") ||
    (message.includes("recent") && message.includes("send"))
  );
}

function parseRetryAfterSeconds(errorLike, fallbackSeconds = 15) {
  const message = String(errorLike && errorLike.message ? errorLike.message : errorLike || "");
  const normalizedFallback = Math.max(1, clampToNonNegativeInt(fallbackSeconds, 15));

  const parseUnit = (valueRaw, unitRaw) => {
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    const unit = String(unitRaw || "s").toLowerCase();
    if (unit.startsWith("ms")) {
      return Math.max(1, Math.ceil(value / 1000));
    }
    if (unit.startsWith("m")) {
      return Math.max(1, Math.ceil(value * 60));
    }
    return Math.max(1, Math.ceil(value));
  };

  const patterns = [
    /retry\s+after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?/i,
    /wait\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?/i,
    /cooldown(?:[^\d]{0,12})(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) {
      continue;
    }

    const parsed = parseUnit(match[1], match[2]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return normalizedFallback;
}

function normalizeConfig(rawConfig) {
  if (!isObject(rawConfig)) {
    throw new Error("config.json must be a JSON object");
  }

  const httpInput = isObject(rawConfig.http) ? rawConfig.http : {};
  const http = {
    timeoutMs: clampToNonNegativeInt(httpInput.timeoutMs, INTERNAL_API_DEFAULTS.http.timeoutMs),
    maxRetries: clampToNonNegativeInt(httpInput.maxRetries, INTERNAL_API_DEFAULTS.http.maxRetries),
    retryBaseDelayMs: clampToNonNegativeInt(
      httpInput.retryBaseDelayMs,
      INTERNAL_API_DEFAULTS.http.retryBaseDelayMs
    )
  };

  if (http.timeoutMs < 1000) {
    throw new Error("config.http.timeoutMs must be >= 1000 ms");
  }

  const pacingInput = isObject(rawConfig.requestPacing) ? rawConfig.requestPacing : {};
  const requestPacing = {
    minDelayMs: clampToNonNegativeInt(
      pacingInput.minDelayMs,
      INTERNAL_API_DEFAULTS.requestPacing.minDelayMs
    ),
    jitterMs: clampToNonNegativeInt(
      pacingInput.jitterMs,
      INTERNAL_API_DEFAULTS.requestPacing.jitterMs
    )
  };

  const recipientFile = String(rawConfig.recipientFile || "recipient.txt").trim();
  if (!recipientFile) {
    throw new Error("config.recipientFile must be a non-empty string");
  }

  const sessionInput = isObject(rawConfig.session) ? rawConfig.session : {};
  const session = {
    preflightOnboard:
      typeof sessionInput.preflightOnboard === "boolean"
        ? sessionInput.preflightOnboard
        : false,
    autoRefreshCheckpoint:
      typeof sessionInput.autoRefreshCheckpoint === "boolean"
        ? sessionInput.autoRefreshCheckpoint
        : true,
    proactiveVercelRefreshMinutes: clampToNonNegativeInt(
      sessionInput.proactiveVercelRefreshMinutes,
      45
    ),
    maxSessionReuseRefreshAttempts: Math.max(
      1,
      clampToNonNegativeInt(sessionInput.maxSessionReuseRefreshAttempts, 3)
    ),
    checkpointSettleDelayMs: Math.max(
      500,
      clampToNonNegativeInt(sessionInput.checkpointSettleDelayMs, 3500)
    ),
    maxOtpRefreshAttempts: Math.max(
      1,
      clampToNonNegativeInt(sessionInput.maxOtpRefreshAttempts, 3)
    ),
    fallbackToOtpOnPersistentCheckpoint:
      typeof sessionInput.fallbackToOtpOnPersistentCheckpoint === "boolean"
        ? sessionInput.fallbackToOtpOnPersistentCheckpoint
        : true
  };

  if (session.maxOtpRefreshAttempts < 1) {
    throw new Error("config.session.maxOtpRefreshAttempts must be >= 1");
  }

  if (session.maxSessionReuseRefreshAttempts < 1) {
    throw new Error("config.session.maxSessionReuseRefreshAttempts must be >= 1");
  }

  const uiInput = isObject(rawConfig.ui) ? rawConfig.ui : {};
  const uiLogLinesInput = Object.prototype.hasOwnProperty.call(uiInput, "logLines")
    ? uiInput.logLines
    : uiInput.maxExecutionLogLines;
  const ui = {
    dashboard:
      typeof uiInput.dashboard === "boolean"
        ? uiInput.dashboard
        : INTERNAL_API_DEFAULTS.ui.dashboard,
    logLines: Math.max(
      1,
      clampToNonNegativeInt(uiLogLinesInput, INTERNAL_API_DEFAULTS.ui.logLines)
    )
  };

  const sendInput = isObject(rawConfig.send) ? rawConfig.send : {};
  const maxLoopTx = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(sendInput, "maxLoopTx")
      ? sendInput.maxLoopTx
      : (
          Object.prototype.hasOwnProperty.call(sendInput, "maxTx")
            ? sendInput.maxTx
            : sendInput.maxTxPerAccount
        ),
    INTERNAL_API_DEFAULTS.send.maxLoopTx
  );
  if (maxLoopTx < 1) {
    throw new Error("config.send.maxLoopTx must be >= 1");
  }

  const legacyDelayBetweenTx = isObject(sendInput.delayBetweenTx)
    ? sendInput.delayBetweenTx
    : sendInput.delayBetweenTx;
  const legacyDelayBetweenTxMin = isObject(legacyDelayBetweenTx)
    ? (
        Object.prototype.hasOwnProperty.call(legacyDelayBetweenTx, "min")
          ? legacyDelayBetweenTx.min
          : legacyDelayBetweenTx.max
      )
    : legacyDelayBetweenTx;
  const legacyDelayBetweenTxMax = isObject(legacyDelayBetweenTx)
    ? (
        Object.prototype.hasOwnProperty.call(legacyDelayBetweenTx, "max")
          ? legacyDelayBetweenTx.max
          : legacyDelayBetweenTx.min
      )
    : legacyDelayBetweenTx;

  const minDelayTxSeconds = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(sendInput, "minDelayTxSeconds")
      ? sendInput.minDelayTxSeconds
      : (
          Object.prototype.hasOwnProperty.call(sendInput, "mindelayTxSeconds")
            ? sendInput.mindelayTxSeconds
            : (
                Object.prototype.hasOwnProperty.call(sendInput, "delayTxSeconds")
                  ? sendInput.delayTxSeconds
                  : legacyDelayBetweenTxMin
              )
        ),
    INTERNAL_API_DEFAULTS.send.minDelayTxSeconds
  );
  const maxDelayTxSeconds = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(sendInput, "maxDelayTxSeconds")
      ? sendInput.maxDelayTxSeconds
      : (
          Object.prototype.hasOwnProperty.call(sendInput, "maxdelayTxSeconds")
            ? sendInput.maxdelayTxSeconds
            : (
                Object.prototype.hasOwnProperty.call(sendInput, "delayTxSeconds")
                  ? sendInput.delayTxSeconds
                  : legacyDelayBetweenTxMax
              )
        ),
    INTERNAL_API_DEFAULTS.send.maxDelayTxSeconds
  );

  if (maxDelayTxSeconds < minDelayTxSeconds) {
    throw new Error("config.send.maxDelayTxSeconds must be >= config.send.minDelayTxSeconds");
  }

  const delayCycleSeconds = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(sendInput, "delayCycleSeconds")
      ? sendInput.delayCycleSeconds
      : (
          Object.prototype.hasOwnProperty.call(sendInput, "delayBetweenCycles")
            ? sendInput.delayBetweenCycles
            : (
                Object.prototype.hasOwnProperty.call(sendInput, "delayBetweenCycle")
                  ? sendInput.delayBetweenCycle
                  : sendInput.loopDelaySeconds
              )
        ),
    INTERNAL_API_DEFAULTS.send.delayCycleSeconds
  );

  const randomAmount = normalizeRandomAmountConfig(
    sendInput.randomAmount,
    INTERNAL_API_DEFAULTS.send.randomAmount,
    "config.send.randomAmount"
  );

  const send = {
    maxLoopTx,
    minDelayTxSeconds,
    maxDelayTxSeconds,
    delayCycleSeconds,
    randomAmount
  };

  return {
    baseUrl: INTERNAL_API_DEFAULTS.baseUrl,
    paths: { ...INTERNAL_API_DEFAULTS.paths },
    headers: {
      ...INTERNAL_API_DEFAULTS.headers,
      extra: {},
      cookie: ""
    },
    http,
    requestPacing,
    recipientFile,
    session,
    send,
    ui
  };
}

function normalizeAccounts(rawAccounts) {
  if (!isObject(rawAccounts)) {
    throw new Error("accounts.json must be a JSON object");
  }

  if (!Array.isArray(rawAccounts.accounts) || rawAccounts.accounts.length === 0) {
    throw new Error("accounts.json must contain a non-empty accounts array");
  }

  const accounts = rawAccounts.accounts.map((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(`accounts[${index}] must be an object`);
    }

    const name = String(entry.name || "").trim();
    const email = String(entry.email || "").trim();
    const address = String(entry.address || entry.cantonPartyId || "").trim();

    if (!name) {
      throw new Error(`accounts[${index}].name is required`);
    }

    if (!email || !email.includes("@")) {
      throw new Error(`accounts[${index}].email is invalid`);
    }

    return {
      name,
      email,
      address
    };
  });

  const names = new Set();
  for (const account of accounts) {
    if (names.has(account.name)) {
      throw new Error(`Duplicate account name in accounts.json: ${account.name}`);
    }
    names.add(account.name);
  }

  const defaultAccount = String(rawAccounts.defaultAccount || accounts[0].name).trim();
  return { defaultAccount, accounts };
}

function extractLegacyAccountCookies(rawAccounts) {
  const cookieMap = new Map();
  if (!isObject(rawAccounts) || !Array.isArray(rawAccounts.accounts)) {
    return cookieMap;
  }

  for (const entry of rawAccounts.accounts) {
    if (!isObject(entry)) {
      continue;
    }

    const name = String(entry.name || "").trim();
    const cookie = String(entry.cookie || "").trim();
    if (name && cookie) {
      cookieMap.set(name, cookie);
    }
  }

  return cookieMap;
}

function selectAccount(accountsConfig, preferredName) {
  const targetName = String(preferredName || accountsConfig.defaultAccount || "").trim();
  const found = accountsConfig.accounts.find((account) => account.name === targetName);
  if (!found) {
    const available = accountsConfig.accounts.map((account) => account.name).join(", ");
    throw new Error(`Account '${targetName}' not found. Available accounts: ${available}`);
  }
  return found;
}

async function promptOtpCode() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = await rl.question("Enter OTP code: ");
    return String(code || "").trim();
  } finally {
    rl.close();
  }
}

async function solveBrowserChallenge(baseUrl, onboardPath, userAgent, headless = true) {
  if (!puppeteer) {
    throw new Error("Puppeteer is not installed. Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth");
  }

  console.log("[browser] Launching browser to solve Vercel challenge...");
  console.log("[browser] Mode: " + (headless ? "headless" : "visible"));

  const browser = await puppeteer.launch({
    headless: headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--window-size=1280,800"
    ],
    defaultViewport: null
  });

  try {
    const page = await browser.newPage();

    // Keep browser challenge fingerprint close to API requests.
    await page.setUserAgent(String(userAgent || INTERNAL_API_DEFAULTS.headers.userAgent));

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9"
    });

    const targetUrl = new URL(onboardPath, baseUrl).toString();
    console.log(`[browser] Navigating to ${targetUrl}`);

    let response;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
    } catch (navError) {
      console.log(`[browser] Navigation issue: ${navError.message}`);
    }

    const status = response ? response.status() : 0;
    console.log(`[browser] Initial response status: ${status}`);

    console.log("[browser] Waiting for Vercel challenge to resolve...");

    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const currentUrl = page.url();
      const cookies = await page.cookies();

      console.log(`[browser] Attempt ${i + 1}: URL=${currentUrl.slice(0, 60)}..., ${cookies.length} cookies`);

      const hasVercelCookie = cookies.some(c => c.name.startsWith("_vc"));
      if (hasVercelCookie) {
        console.log("[browser] Vercel security cookies obtained!");
        break;
      }

      if (currentUrl.includes("/onboard") && cookies.length > 0) {
        console.log("[browser] Page loaded with cookies");
        break;
      }
    }

    console.log("[browser] Final cookie extraction...");
    await sleep(1000);

    const cookies = await page.cookies();
    console.log(`[browser] Extracted ${cookies.length} cookies:`);

    const cookieMap = new Map();
    for (const cookie of cookies) {
      cookieMap.set(cookie.name, cookie.value);
      const valuePreview = cookie.value.length > 40 ? cookie.value.slice(0, 40) + "..." : cookie.value;
      console.log(`[browser]   ${cookie.name}=${valuePreview}`);
    }

    return cookieMap;
  } finally {
    await browser.close();
    console.log("[browser] Browser closed");
  }
}

class RootsFiApiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.paths = config.paths;
    this.headers = config.headers;
    this.http = config.http;
    this.requestPacing = config.requestPacing;
    this.cookieJar = new Map();
    this.initializeCookiesFromConfig();
  }

  initializeCookiesFromConfig() {
    const configCookie = this.headers.cookie;
    if (configCookie) {
      this.parseCookieString(configCookie);
    }
  }

  parseCookieString(cookieStr) {
    if (!cookieStr) return;
    const pairs = cookieStr.split(";");
    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex > 0) {
        const name = pair.slice(0, eqIndex).trim();
        const value = pair.slice(eqIndex + 1).trim();
        if (name) {
          this.cookieJar.set(name, value);
        }
      }
    }
  }

  parseSetCookieHeaders(headers) {
    const setCookieHeaders = [];

    if (typeof headers.getSetCookie === "function") {
      const values = headers.getSetCookie();
      if (Array.isArray(values) && values.length > 0) {
        setCookieHeaders.push(...values);
      }
    }

    if (setCookieHeaders.length === 0) {
      const combined = headers.get("set-cookie");
      if (combined) {
        setCookieHeaders.push(...this.splitCombinedSetCookieHeader(combined));
      }
    }

    for (const setCookie of setCookieHeaders) {
      const parts = setCookie.split(";")[0];
      const eqIndex = parts.indexOf("=");
      if (eqIndex > 0) {
        const name = parts.slice(0, eqIndex).trim();
        const value = parts.slice(eqIndex + 1).trim();
        if (name) {
          this.cookieJar.set(name, value);
        }
      }
    }
  }

  splitCombinedSetCookieHeader(headerValue) {
    if (!headerValue) {
      return [];
    }

    const parts = [];
    let current = "";
    let inExpiresAttr = false;

    for (let i = 0; i < headerValue.length; i += 1) {
      const next8 = headerValue.slice(i, i + 8).toLowerCase();
      if (next8 === "expires=") {
        inExpiresAttr = true;
      }

      const ch = headerValue[i];
      if (ch === "," && !inExpiresAttr) {
        const trimmed = current.trim();
        if (trimmed) {
          parts.push(trimmed);
        }
        current = "";
        continue;
      }

      current += ch;

      if (inExpiresAttr && ch === ";") {
        inExpiresAttr = false;
      }
    }

    const last = current.trim();
    if (last) {
      parts.push(last);
    }

    return parts;
  }

  mergeCookies(cookieMap) {
    for (const [name, value] of cookieMap) {
      this.cookieJar.set(name, value);
    }
  }

  hasValidSession() {
    return this.hasSecurityCookie() || this.hasAccountSessionCookie();
  }

  hasSecurityCookie() {
    return this.cookieJar.has("_vcrcs");
  }

  hasAccountSessionCookie() {
    return this.cookieJar.has("cantonbridge_session");
  }

  logCookieStatus(context) {
    console.log(
      `[info] Cookie status (${context}): _vcrcs=${this.hasSecurityCookie()} cantonbridge_session=${this.hasAccountSessionCookie()} total=${this.cookieJar.size}`
    );
  }

  getCookieStatus() {
    return {
      security: this.hasSecurityCookie(),
      session: this.hasAccountSessionCookie(),
      total: this.cookieJar.size
    };
  }

  getCookieHeader() {
    if (this.cookieJar.size === 0) {
      return "";
    }
    const pairs = [];
    for (const [name, value] of this.cookieJar) {
      pairs.push(`${name}=${value}`);
    }
    return pairs.join("; ");
  }

  buildUrl(endpointPath) {
    return new URL(endpointPath, this.baseUrl).toString();
  }

  buildHeaders(method, refererPath, hasBody, accept = "*/*") {
    const headers = {
      accept,
      "accept-language": this.headers.acceptLanguage,
      referer: this.buildUrl(refererPath),
      "user-agent": this.headers.userAgent
    };

    if (this.headers.sendBrowserClientHints) {
      headers["sec-ch-ua"] = this.headers.secChUa;
      headers["sec-ch-ua-mobile"] = this.headers.secChUaMobile;
      headers["sec-ch-ua-platform"] = this.headers.secChUaPlatform;
      headers["sec-fetch-dest"] = this.headers.secFetchDest;
      headers["sec-fetch-mode"] = this.headers.secFetchMode;
      headers["sec-fetch-site"] = this.headers.secFetchSite;
      headers.priority = this.headers.priority;
    }

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    for (const [key, value] of Object.entries(this.headers.extra)) {
      headers[key] = value;
    }

    if (method !== "GET") {
      headers.origin = this.baseUrl;
      if (hasBody) {
        headers["content-type"] = "application/json";
      }
    }

    return headers;
  }

  extractApiError(payload) {
    if (!isObject(payload)) {
      return "unknown API error";
    }

    if (isObject(payload.error)) {
      if (typeof payload.error.message === "string" && payload.error.message.trim()) {
        return payload.error.message;
      }
      if (typeof payload.error.code === "string" && payload.error.code.trim()) {
        return payload.error.code;
      }
    }

    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }

    if (isObject(payload.data) && typeof payload.data.message === "string" && payload.data.message.trim()) {
      return payload.data.message;
    }

    const compact = JSON.stringify(payload);
    if (compact && compact !== "{}") {
      return compact.slice(0, 240);
    }

    return "unknown API error";
  }

  shouldRetry(error) {
    const status = Number(error && error.status);
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }

    const message = String(error && error.message ? error.message : "").toLowerCase();
    return (
      message.includes("timed out") ||
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("aborted")
    );
  }

  async waitForPacing() {
    const min = this.requestPacing.minDelayMs;
    const jitter = this.requestPacing.jitterMs;
    const delay = min + (jitter > 0 ? randomIntInclusive(0, jitter) : 0);

    if (delay > 0) {
      await sleep(delay);
    }
  }

  async waitForBackoff(attempt) {
    const base = this.http.retryBaseDelayMs;
    if (base <= 0) {
      return;
    }

    const exponential = base * Math.pow(2, attempt - 1);
    const jitter = randomIntInclusive(0, Math.max(1, Math.floor(base / 2)));
    await sleep(exponential + jitter);
  }

  async requestJson(method, endpointPath, options = {}) {
    const body = options.body;
    const refererPath = options.refererPath || this.paths.onboard;
    const accept = options.accept || "*/*";
    const timeoutMs = clampToNonNegativeInt(options.timeoutMs, this.http.timeoutMs);
    const maxAttempts = 1 + this.http.maxRetries;
    // Allow disabling infinite timeout retry for non-critical endpoints
    const skipInfiniteTimeoutRetry = Boolean(options.skipInfiniteTimeoutRetry);

    let lastError = null;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(new Error("Request timed out")), timeoutMs);

      try {
        const response = await fetch(this.buildUrl(endpointPath), {
          method,
          headers: this.buildHeaders(method, refererPath, body !== undefined, accept),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: abortController.signal
        });

        clearTimeout(timeoutId);

        this.parseSetCookieHeaders(response.headers);

        const contentType = String(response.headers.get("content-type") || "");
        const vercelMitigated = String(response.headers.get("x-vercel-mitigated") || "");
        const vercelRequestId = String(response.headers.get("x-vercel-id") || "");
        const text = await response.text();
        let payload = {};
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            if (text.trim().startsWith("<")) {
              if (vercelMitigated.toLowerCase() === "challenge") {
                const requestRef = vercelRequestId ? ` requestId=${vercelRequestId}` : "";
                throw new Error(
                  `Blocked by Vercel Security Checkpoint at ${endpointPath} (HTTP ${response.status}).` +
                    `${requestRef} Complete browser verification first, then place your session cookie in ` +
                    "tokens.json (selected account token profile) and retry."
                );
              }

              throw new Error(
                `Expected JSON from ${endpointPath}, but received HTML content (HTTP ${response.status}, content-type=${contentType || "unknown"}).`
              );
            }
            throw new Error(`Expected JSON response from ${endpointPath}, got: ${text.slice(0, 200)}`);
          }
        }

        if (!response.ok) {
          const requestError = new Error(
            `HTTP ${response.status} from ${endpointPath}: ${this.extractApiError(payload)}`
          );
          requestError.status = response.status;
          throw requestError;
        }

        if (isObject(payload) && Object.prototype.hasOwnProperty.call(payload, "success") && payload.success === false) {
          throw new Error(`API failure from ${endpointPath}: ${this.extractApiError(payload)}`);
        }

        await this.waitForPacing();
        return payload;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;

        // TIMEOUT errors: infinite retry dengan exponential backoff
        // UNLESS skipInfiniteTimeoutRetry is set (for non-critical endpoints)
        if (isTimeoutError(error)) {
          if (skipInfiniteTimeoutRetry) {
            // For non-critical endpoints, just throw timeout error immediately
            throw error;
          }
          const backoffMs = calculateTimeoutBackoffMs(attempt);
          const backoffSec = Math.round(backoffMs / 1000);
          console.log(
            `[timeout-retry] ${method} ${endpointPath} timed out (attempt ${attempt}). ` +
            `Retrying in ${backoffSec}s (max: ${TIMEOUT_BACKOFF_MAX_MS / 1000}s)...`
          );
          await sleep(backoffMs);
          continue; // infinite retry untuk timeout
        }

        // Non-timeout errors: gunakan maxAttempts normal
        if (attempt < maxAttempts && this.shouldRetry(error)) {
          await this.waitForBackoff(attempt);
          continue;
        }

        throw error;
      }
    }
  }

  async preflightOnboard() {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(new Error("Request timed out")), this.http.timeoutMs);

    try {
      const cookieHeader = this.getCookieHeader();
      const headers = {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": this.headers.acceptLanguage,
        "user-agent": this.headers.userAgent
      };
      if (cookieHeader) {
        headers.cookie = cookieHeader;
      }

      const response = await fetch(this.buildUrl(this.paths.onboard), {
        method: "GET",
        headers,
        signal: abortController.signal
      });

      this.parseSetCookieHeaders(response.headers);

      if (!response.ok) {
        const err = new Error(`Failed preflight GET ${this.paths.onboard}: HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }

      // Preflight only needs headers/cookies. Avoid waiting full HTML body to prevent stalls.
      if (response.body && typeof response.body.cancel === "function") {
        try {
          await response.body.cancel();
        } catch {
          // Ignore body cancel errors; cookies have already been captured from headers.
        }
      }
      await this.waitForPacing();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async syncAccount(refererPath) {
    return this.requestJson("POST", this.paths.syncAccount, { refererPath });
  }

  async getPending(refererPath) {
    return this.requestJson("GET", this.paths.authPending, { refererPath });
  }

  async sendOtp(email) {
    return this.requestJson("POST", this.paths.sendOtp, {
      refererPath: this.paths.onboard,
      body: { email }
    });
  }

  async verifyOtp(payload) {
    return this.requestJson("POST", this.paths.verifyOtp, {
      refererPath: this.paths.onboard,
      body: payload
    });
  }

  async finalizeReturning() {
    return this.requestJson("POST", this.paths.finalizeReturning, {
      refererPath: this.paths.onboard
    });
  }

  async getBalances() {
    return this.requestJson("GET", this.paths.walletBalances, {
      refererPath: this.paths.bridge
    });
  }

  async checkCcCooldown(recipient) {
    return this.requestJson("POST", this.paths.sendCcCooldown, {
      refererPath: this.paths.send,
      body: {
        recipientType: "canton_wallet",
        recipient,
        preferredNetwork: "canton",
        tokenType: "CC",
        instrumentId: "Amulet"
      }
    });
  }

  async resolveSendRecipient(recipient) {
    return this.requestJson("POST", this.paths.sendResolve, {
      refererPath: this.paths.send,
      body: {
        cantonPartyId: recipient,
        preferredNetwork: "canton"
      }
    });
  }

  async sendCcTransfer(recipient, amount, idempotencyKey) {
    return this.requestJson("POST", this.paths.sendTransfer, {
      refererPath: this.paths.send,
      timeoutMs: 90000,
      body: {
        recipientType: "canton_wallet",
        recipient,
        amount,
        idempotencyKey,
        preferredNetwork: "canton",
        tokenType: "CC",
        instrumentId: "Amulet"
      }
    });
  }

  async getSendHistory() {
    return this.requestJson("GET", this.paths.sendHistory, {
      refererPath: this.paths.send
    });
  }

  async getCcOutgoing() {
    return this.requestJson("GET", this.paths.walletCcOutgoing, {
      refererPath: this.paths.send
    });
  }

  async getRewardsLottery() {
    const endpointPath = this.paths.rewardsLottery || this.paths.rewardsSendLoyaltyDailyTaper;
    // Non-critical endpoint: single attempt with short timeout, no retry
    const abortController = new AbortController();
    const timeoutMs = 10000; // 10 second timeout for rewards
    const timeoutId = setTimeout(() => abortController.abort(new Error("Rewards timeout")), timeoutMs);
    
    try {
      const response = await fetch(this.buildUrl(endpointPath), {
        method: "GET",
        headers: this.buildHeaders("GET", this.paths.rewards || this.paths.bridge, false, "*/*"),
        signal: abortController.signal
      });
      
      clearTimeout(timeoutId);
      this.parseSetCookieHeaders(response.headers);
      
      const text = await response.text();
      if (!text) return {};
      
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } catch (error) {
      clearTimeout(timeoutId);
      // Non-critical - just throw, caller will catch and ignore
      throw error;
    }
  }

  async getRewardsThisWeek() {
    // Non-critical endpoint: single attempt with short timeout, no retry
    const abortController = new AbortController();
    const timeoutMs = 10000; // 10 second timeout for rewards
    const timeoutId = setTimeout(() => abortController.abort(new Error("Rewards timeout")), timeoutMs);
    
    try {
      const response = await fetch(this.buildUrl(this.paths.rewardsSendLoyaltyDailyTaper), {
        method: "GET",
        headers: this.buildHeaders("GET", this.paths.rewards || this.paths.bridge, false, "*/*"),
        signal: abortController.signal
      });
      
      clearTimeout(timeoutId);
      this.parseSetCookieHeaders(response.headers);
      
      const text = await response.text();
      if (!text) return {};
      
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } catch (error) {
      clearTimeout(timeoutId);
      // Non-critical - just throw, caller will catch and ignore
      throw error;
    }
  }
}

function printBalanceSummary(data) {
  const balances = isObject(data.balances) ? data.balances : {};
  const wallets = isObject(data.wallets) ? data.wallets : {};

  const ethereum = isObject(balances.ethereum) ? balances.ethereum : {};
  const canton = isObject(balances.canton) ? balances.canton : {};

  const holdingsBySymbol = new Map();
  const pushHoldings = (items) => {
    if (!Array.isArray(items)) {
      return;
    }

    for (const holding of items) {
      if (!isObject(holding)) {
        continue;
      }

      const metadata = isObject(holding.metadata) ? holding.metadata : {};
      const rawSymbol = String(metadata.symbol || holding.instrumentId || "UNKNOWN").trim();
      const symbol = rawSymbol.toUpperCase();
      const amount = String(
        holding.amountDecimal ??
          holding.amount ??
          holding.amountBaseUnits ??
          "0"
      ).trim();

      if (!symbol) {
        continue;
      }

      if (!holdingsBySymbol.has(symbol)) {
        holdingsBySymbol.set(symbol, amount || "0");
      }
    }
  };

  // tokenHoldings usually has richer amount fields; use it before otherHoldings.
  pushHoldings(canton.tokenHoldings);
  pushHoldings(canton.otherHoldings);

  const ccBalance = holdingsBySymbol.get("CC") || "0";
  const cbtcBalance = holdingsBySymbol.get("CBTC") || "0";

  console.log("[balance] Ethereum");
  console.log(`  ETH: ${ethereum.eth ?? "n/a"}`);
  console.log(`  USDC: ${ethereum.usdc ?? "n/a"}`);

  console.log("[balance] Canton");
  console.log(`  USDCx: ${canton.usdcx ?? "n/a"}`);
  console.log(`  CC: ${ccBalance}`);
  console.log(`  Available: ${canton.available ?? "n/a"}`);

  if (holdingsBySymbol.size > 0) {
    console.log("[balance] Canton Holdings");
    for (const [symbol, amount] of holdingsBySymbol.entries()) {
      console.log(`  ${symbol}: ${amount}`);
    }
  }

  console.log("[wallets]");
  console.log(`  ethAddress: ${wallets.ethAddress ?? "n/a"}`);
  console.log(`  cantonPartyId: ${wallets.cantonPartyId ?? "n/a"}`);

  return {
    eth: String(ethereum.eth ?? "n/a"),
    usdc: String(ethereum.usdc ?? "n/a"),
    usdcx: String(canton.usdcx ?? "n/a"),
    cc: String(ccBalance ?? "0"),
    cbtc: String(cbtcBalance ?? "0"),
    ccNumeric: Number(ccBalance) || 0,
    available: canton.available === true || canton.available === "true",
    cantonPartyId: String(wallets.cantonPartyId ?? "n/a")
  };
}

// API call with timeout wrapper
const API_CALL_TIMEOUT_MS = 30000; // 30 seconds
const API_CALL_MAX_RETRIES = 2;

// Timeout infinite backoff settings
const TIMEOUT_BACKOFF_BASE_MS = 5000;       // 5 detik base delay
const TIMEOUT_BACKOFF_MAX_MS = 300000;      // 5 menit max delay
const TIMEOUT_BACKOFF_JITTER_MS = 30000;    // 0-30 detik random jitter

function calculateTimeoutBackoffMs(attempt) {
  // Exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s, 300s (capped)
  const exponential = Math.min(
    TIMEOUT_BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
    TIMEOUT_BACKOFF_MAX_MS
  );
  const jitter = randomIntInclusive(0, TIMEOUT_BACKOFF_JITTER_MS);
  return exponential + jitter;
}

async function apiCallWithTimeout(apiCall, label, timeoutMs = API_CALL_TIMEOUT_MS) {
  const startTime = Date.now();
  
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  
  const result = await Promise.race([apiCall(), timeoutPromise]);
  const elapsed = Date.now() - startTime;
  console.log(`[info] ${label} completed in ${elapsed}ms`);
  return result;
}

async function apiCallWithRetry(apiCall, label, maxRetries = API_CALL_MAX_RETRIES, timeoutMs = API_CALL_TIMEOUT_MS) {
  let lastError = null;
  let attempt = 0;

  while (true) {
    attempt += 1;

    try {
      const attemptLabel = lastError && isTimeoutError(lastError)
        ? `${label} (timeout retry ${attempt})`
        : `${label} (attempt ${attempt}/${maxRetries})`;

      return await apiCallWithTimeout(apiCall, attemptLabel, timeoutMs);
    } catch (error) {
      lastError = error;

      // TIMEOUT errors: infinite retry dengan exponential backoff
      if (isTimeoutError(error)) {
        const backoffMs = calculateTimeoutBackoffMs(attempt);
        const backoffSec = Math.round(backoffMs / 1000);
        console.log(
          `[timeout-retry] ${label} timed out (attempt ${attempt}). ` +
          `Retrying in ${backoffSec}s (max: ${TIMEOUT_BACKOFF_MAX_MS / 1000}s)...`
        );
        await sleep(backoffMs);
        continue; // infinite retry untuk timeout
      }

      // Non-timeout errors: gunakan maxRetries normal
      console.log(
        `[warn] ${label} attempt ${attempt}/${maxRetries} failed: ${error.message}`
      );

      if (attempt < maxRetries) {
        const retryDelay = 3000 * attempt; // 3s, 6s, etc
        console.log(`[info] Retrying ${label} in ${retryDelay / 1000}s...`);
        await sleep(retryDelay);
        continue;
      }

      // Max retries reached untuk non-timeout errors
      throw lastError;
    }
  }
}

async function executeCcSendFlow(client, sendRequest, accountLogTag = null) {
  const stepLog = (message) => console.log(withAccountTag(accountLogTag, message));

  console.log(`[send] Target (${sendRequest.source}): ${sendRequest.label}`);
  console.log(`[send] Canton recipient: ${sendRequest.address}`);
  console.log(`[send] Amount: ${sendRequest.amount} CC`);

  // Step 1: Cooldown check with retry
  stepLog("[step] Send cooldown check");
  const cooldownResponse = await apiCallWithRetry(
    () => client.checkCcCooldown(sendRequest.address),
    "Cooldown check"
  );
  const cooldownData = isObject(cooldownResponse.data) ? cooldownResponse.data : {};

  if (cooldownData.blocked) {
    throw new Error(
      `CC send cooldown is active. Retry after ${cooldownData.retryAfterSeconds ?? "unknown"} seconds.`
    );
  }
  console.log(
    `[info] Cooldown passed (retryAfterSeconds=${cooldownData.retryAfterSeconds ?? 0}, cooldownMinutes=${cooldownData.cooldownMinutes ?? "n/a"})`
  );

  // Step 2: Resolve recipient (skip for external wallets, no retry needed)
  stepLog("[step] Resolve recipient");
  try {
    const resolveResponse = await apiCallWithTimeout(
      () => client.resolveSendRecipient(sendRequest.address),
      "Resolve recipient",
      15000 // 15s timeout
    );
    const resolveData = isObject(resolveResponse.data) ? resolveResponse.data : {};
    const preview = JSON.stringify(resolveData).slice(0, 180);
    console.log(`[info] Resolve response: ${preview || "ok"}`);
  } catch (error) {
    const message = String(error && error.message ? error.message : "");
    if (message.includes("No Roots user is linked to this Canton address")) {
      console.log("[info] External wallet (not a Roots user), proceeding with direct transfer.");
    } else {
      console.log(`[warn] Resolve check failed: ${message}`);
    }
  }

  // Step 3: Get history before transfer (for matching later)
  stepLog("[step] Get send history (before transfer)");
  let beforeSendIds = new Set();
  try {
    const beforeHistoryResponse = await apiCallWithRetry(
      () => client.getSendHistory(),
      "Get history (before)"
    );
    const beforeSends = isObject(beforeHistoryResponse.data) && Array.isArray(beforeHistoryResponse.data.sends)
      ? beforeHistoryResponse.data.sends
      : [];
    beforeSendIds = new Set(beforeSends.map((item) => (isObject(item) ? item.id : null)).filter(Boolean));
  } catch (error) {
    console.log(`[warn] Could not get history before transfer: ${error.message}`);
    console.log("[info] Continuing with transfer anyway...");
  }

  // Step 4: Transfer CC with retry
  const idempotencyKey = sendRequest.idempotencyKey || crypto.randomUUID();
  stepLog(`[step] Transfer CC (idempotencyKey=${idempotencyKey})`);

  let transferResponse = null;
  try {
    transferResponse = await apiCallWithRetry(
      () => client.sendCcTransfer(sendRequest.address, sendRequest.amount, idempotencyKey),
      "Transfer CC",
      API_CALL_MAX_RETRIES,
      60000 // 60s timeout for transfer (longer)
    );
  } catch (error) {
    const message = String(error && error.message ? error.message : "").toLowerCase();
    if (message.includes("timeout")) {
      console.log("[warn] Transfer request timed out after all retries, checking history...");
    } else {
      throw error;
    }
  }

  const transferData = isObject(transferResponse && transferResponse.data) ? transferResponse.data : {};
  const transferId = String(transferData.id || "").trim();
  const transferUpdateId = isObject(transferData.command_result) && isObject(transferData.command_result.transfer)
    ? String(transferData.command_result.transfer.updateId || "").trim()
    : "";

  if (transferId) {
    console.log(
      `[info] Transfer submitted: id=${transferId}${transferUpdateId ? ` updateId=${transferUpdateId}` : ""}`
    );
  }

  // Step 5: Check send history (to confirm transfer)
  stepLog("[step] Check send history");
  let matchedSend = null;
  try {
    const historyResponse = await apiCallWithRetry(
      () => client.getSendHistory(),
      "Get history (after)"
    );
    const sends = isObject(historyResponse.data) && Array.isArray(historyResponse.data.sends)
      ? historyResponse.data.sends
      : [];

    if (transferId) {
      matchedSend = sends.find((item) => isObject(item) && item.id === transferId) || null;
    }

    if (!matchedSend) {
      matchedSend = sends.find((item) => {
        if (!isObject(item) || !item.id || beforeSendIds.has(item.id)) {
          return false;
        }
        return String(item.direction || "").toLowerCase() === "sent" && String(item.amount || "") === sendRequest.amount;
      }) || null;
    }

    if (matchedSend) {
      console.log(
        `[info] Transfer history: id=${matchedSend.id} status=${matchedSend.status ?? "unknown"} amount=${matchedSend.amount ?? sendRequest.amount} token=${matchedSend.tokenType ?? "CC"}`
      );
    } else {
      console.log("[warn] Could not find a matching transfer in immediate history response.");
    }
  } catch (error) {
    console.log(`[warn] Could not check history after transfer: ${error.message}`);
  }

  // Step 6: Check outgoing (optional, non-fatal)
  try {
    const outgoingResponse = await apiCallWithTimeout(
      () => client.getCcOutgoing(),
      "Get outgoing",
      15000
    );
    const outgoing = isObject(outgoingResponse.data) && Array.isArray(outgoingResponse.data.outgoing)
      ? outgoingResponse.data.outgoing
      : [];
    console.log(`[info] Pending outgoing CC count: ${outgoing.length}`);
  } catch (error) {
    console.log(`[warn] Could not read cc-outgoing: ${error.message}`);
  }

  return {
    transferId: matchedSend && matchedSend.id ? String(matchedSend.id) : transferId,
    status: matchedSend && matchedSend.status ? String(matchedSend.status) : transferId ? "submitted" : "unknown",
    amount: String(sendRequest.amount),
    recipient: String(sendRequest.label)
  };
}

async function executeCcSendFlowWithCheckpointRecovery(
  client,
  sendRequest,
  config,
  onCheckpointRefresh,
  accountLogTag = null
) {
  try {
    return await executeCcSendFlow(client, sendRequest, accountLogTag);
  } catch (error) {
    if (!isVercelCheckpointError(error)) {
      throw error;
    }

    if (!config.session.autoRefreshCheckpoint) {
      throw new Error(
        "Send flow hit Vercel checkpoint and auto refresh is disabled (config.session.autoRefreshCheckpoint=false)."
      );
    }

    console.log("[info] Send flow hit Vercel checkpoint, refreshing browser security cookies...");
    const browserCookies = await solveBrowserChallenge(
      config.baseUrl,
      config.paths.onboard,
      config.headers.userAgent,
      true
    );
    client.mergeCookies(browserCookies);
    if (typeof onCheckpointRefresh === "function") {
      onCheckpointRefresh();
    }
    client.logCookieStatus("after browser refresh for send");

    return await executeCcSendFlow(client, sendRequest, accountLogTag);
  }
}

// Balance check with timeout - returns null if timeout/error (proceed with TX anyway)
const BALANCE_CHECK_TIMEOUT_MS = 10000;
const TX_RETRY_INITIAL_DELAY_SECONDS = 15;
const TX_RETRY_DELAY_STEP_SECONDS = 30;
const SESSION_REUSE_TIMEOUT_BACKOFF_SECONDS = 15;

async function getBalanceWithTimeout(client, timeoutMs = BALANCE_CHECK_TIMEOUT_MS) {
  const startTime = Date.now();
  
  try {
    const balancePromise = client.getBalances();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Balance check timeout")), timeoutMs);
    });
    
    const balanceResponse = await Promise.race([balancePromise, timeoutPromise]);
    const elapsed = Date.now() - startTime;
    console.log(`[info] Balance check completed in ${elapsed}ms`);
    
    const balanceData = balanceResponse && balanceResponse.data ? balanceResponse.data : {};
    return printBalanceSummary(balanceData);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`[warn] Balance check failed after ${elapsed}ms: ${error.message}`);
    return null; // Return null to indicate balance check failed/timeout
  }
}

function formatThisWeekRewardLabel(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "" || typeof rawValue === "boolean") {
    return "-";
  }

  const numeric = Number(rawValue);
  if (Number.isFinite(numeric)) {
    return `CC${numeric.toFixed(2)}`;
  }

  const text = String(rawValue).trim();
  if (!text) {
    return "-";
  }

  return /^cc/i.test(text) ? text.toUpperCase() : `CC${text}`;
}

function extractThisWeekRewardLabelFromResponse(payload) {
  const data = isObject(payload && payload.data) ? payload.data : {};
  const candidates = [];

  candidates.push(data.earnedThisWeekCc, data.thisWeekCc, data.rewardThisWeekCc);

  if (isObject(data.tierProgress)) {
    candidates.push(
      data.tierProgress.earnedThisWeekCc,
      data.tierProgress.thisWeekRewardCc,
      data.tierProgress.rewardThisWeekCc,
      data.tierProgress.thisWeekCc
    );
  }

  candidates.push(data.thisWeekRewardCc, data.thisWeekReward, data.weeklyRewardCc, data.weeklyReward);

  if (isObject(data.thisWeek)) {
    candidates.push(data.thisWeek.cc, data.thisWeek.amount, data.thisWeek.reward, data.thisWeek.value);
  }

  if (isObject(data.weekly)) {
    candidates.push(data.weekly.cc, data.weekly.amount, data.weekly.reward, data.weekly.value);
  }

  candidates.push(data.accrualsWeek, data.accrualsThisWeek, data.accrualsToday);

  for (const value of candidates) {
    const label = formatThisWeekRewardLabel(value);
    if (label !== "-") {
      return label;
    }
  }

  return "-";
}

async function refreshThisWeekRewardDashboard(client, dashboard, accountLogTag = null) {
  let rewardLabel = "-";

  // Reward check is non-critical - single attempt without retry
  // If it fails/timeouts, just skip silently - don't block main TX flow
  try {
    const lotteryResponse = await client.getRewardsLottery();
    rewardLabel = extractThisWeekRewardLabelFromResponse(lotteryResponse);
  } catch (error) {
    // Silent fail for timeout - non-critical
    if (!isTimeoutError(error)) {
      console.log(withAccountTag(accountLogTag, `[warn] Lottery reward endpoint failed: ${error.message}`));
    }
  }

  if (rewardLabel === "-") {
    try {
      const fallbackResponse = await client.getRewardsThisWeek();
      rewardLabel = extractThisWeekRewardLabelFromResponse(fallbackResponse);
    } catch (error) {
      // Silent fail for fallback too
      if (!isTimeoutError(error)) {
        console.log(withAccountTag(accountLogTag, `[warn] Fallback reward endpoint failed: ${error.message}`));
      }
    }
  }

  if (rewardLabel !== "-") {
    dashboard.setState({ reward: rewardLabel });
    console.log(withAccountTag(accountLogTag, `[info] This Week Reward: ${rewardLabel}`));
  }
  // Don't log warning for timeout - just silently skip
}

async function executeSendBatch(client, sendRequests, config, dashboard, onCheckpointRefresh, accountLogTag = null, senderAccountName = null) {
  if (!Array.isArray(sendRequests) || sendRequests.length === 0) {
    return {
      completedTx: 0,
      skippedTx: 0,
      deferred: false,
      deferReason: null,
      deferRetryAfterSeconds: 0,
      deferRequiredAmount: null,
      deferAvailableAmount: null,
      deferProgress: null,
      deferSendLabel: null
    };
  }

  const stepLog = (message) => console.log(withAccountTag(accountLogTag, message));
  const minDelayTxSec = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(config.send, "minDelayTxSeconds")
      ? config.send.minDelayTxSeconds
      : config.send.delayTxSeconds,
    INTERNAL_API_DEFAULTS.send.minDelayTxSeconds
  );
  const maxDelayTxSec = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(config.send, "maxDelayTxSeconds")
      ? config.send.maxDelayTxSeconds
      : config.send.delayTxSeconds,
    INTERNAL_API_DEFAULTS.send.maxDelayTxSeconds
  );
  const delayTxMinSec = Math.min(minDelayTxSec, maxDelayTxSec);
  const delayTxMaxSec = Math.max(minDelayTxSec, maxDelayTxSec);

  let completedTx = 0;
  let skippedTx = 0;
  let deferredState = null;

  dashboard.setState({
    swapsTotal: `0/${sendRequests.length}`,
    swapsOk: "0",
    swapsFail: "0"
  });

  for (let index = 0; index < sendRequests.length; index += 1) {
    const sendRequest = sendRequests[index];
    const progress = `${index + 1}/${sendRequests.length}`;

    // Check balance before each TX (with timeout fallback)
    stepLog(`[step] Check balance before tx ${progress} (timeout=${BALANCE_CHECK_TIMEOUT_MS}ms)`);
    const currentBalance = await getBalanceWithTimeout(client);
    
    if (currentBalance !== null) {
      dashboard.setState({
        balance: `CC=${currentBalance.cc} | USDCx=${currentBalance.usdcx} | CBTC=${currentBalance.cbtc}`
      });
      
      console.log(`[info] Current balance: CC=${currentBalance.cc} (${currentBalance.ccNumeric}) | Available=${currentBalance.available}`);
      
      // Check if balance is sufficient (use ccNumeric for comparison)
      const requiredAmount = Number(sendRequest.amount);
      const availableAmount = currentBalance.ccNumeric;

      if (!Number.isFinite(availableAmount) || availableAmount < requiredAmount) {
        const retryAfterSeconds = TX_RETRY_INITIAL_DELAY_SECONDS;
        console.log(
          `[warn] Deferring tx ${progress} due insufficient balance: need ${requiredAmount} CC, have ${availableAmount} CC (retry in ${retryAfterSeconds}s)`
        );
        dashboard.setState({
          phase: "cooldown",
          swapsTotal: `${index + 1}/${sendRequests.length}`,
          swapsOk: String(completedTx),
          swapsFail: String(skippedTx),
          transfer: `deferred (insufficient) (${progress})`,
          cooldown: `${retryAfterSeconds}s`,
          send: `Deferred ${sendRequest.amount} CC -> ${sendRequest.label} (waiting inbound)`
        });

        deferredState = {
          reason: "insufficient-balance",
          retryAfterSeconds,
          requiredAmount,
          availableAmount,
          progress,
          sendLabel: `${sendRequest.amount} CC -> ${sendRequest.label}`
        };
        break;
      }
    } else {
      // Balance check failed/timeout - proceed with TX anyway
      console.log(`[info] Balance check timeout/failed, proceeding with tx ${progress} anyway...`);
    }

    dashboard.setState({
      phase: "send",
      send: `${sendRequest.amount} CC -> ${sendRequest.label} (${progress})`,
      swapsTotal: `${index + 1}/${sendRequests.length}`,
      swapsOk: String(completedTx),
      swapsFail: String(skippedTx)
    });

    stepLog(`[step] Send tx ${progress}: ${sendRequest.amount} CC -> ${sendRequest.label}`);

    let sendResult = null;
    let retryAttempt = 0;
    while (sendResult === null && deferredState === null) {
      try {
        sendResult = await executeCcSendFlowWithCheckpointRecovery(
          client,
          sendRequest,
          config,
          onCheckpointRefresh,
          accountLogTag
        );
      } catch (error) {
        if (isSendEligibilityDelayError(error)) {
          // SEND COOLDOWN: use minimum 7 minutes (420s) delay before any backoff
          const SEND_COOLDOWN_MIN_DELAY_SECONDS = 420; // 7 minutes
          const serverRetryAfter = parseRetryAfterSeconds(error, SEND_COOLDOWN_MIN_DELAY_SECONDS);
          const retryAfterSeconds = Math.max(serverRetryAfter, SEND_COOLDOWN_MIN_DELAY_SECONDS);
          const errorMessage = String(error && error.message ? error.message : error);
          console.warn(
            `[warn] Deferring tx ${progress} due server send rule. Retry in ${retryAfterSeconds}s (min 7min): ${errorMessage}`
          );
          dashboard.setState({
            phase: "cooldown",
            transfer: `deferred (server-cooldown) (${progress})`,
            send: `Deferred ${sendRequest.amount} CC -> ${sendRequest.label} for ${retryAfterSeconds}s`,
            cooldown: `${retryAfterSeconds}s`,
            swapsTotal: `${index + 1}/${sendRequests.length}`,
            swapsOk: String(completedTx),
            swapsFail: String(skippedTx)
          });
          deferredState = {
            reason: "server-cooldown",
            retryAfterSeconds,
            requiredAmount: Number(sendRequest.amount),
            availableAmount: null,
            progress,
            sendLabel: `${sendRequest.amount} CC -> ${sendRequest.label}`
          };
          break;
        }

        retryAttempt += 1;
        const retryDelaySeconds =
          TX_RETRY_INITIAL_DELAY_SECONDS + ((retryAttempt - 1) * TX_RETRY_DELAY_STEP_SECONDS);
        const errorMessage = String(error && error.message ? error.message : error);

        console.warn(
          `[warn] TX ${progress} failed (attempt ${retryAttempt}) and will retry in ${retryDelaySeconds}s: ${errorMessage}`
        );

        dashboard.setState({
          phase: "cooldown",
          transfer: `retry-${retryAttempt} (${progress})`,
          send: `Retrying ${sendRequest.amount} CC -> ${sendRequest.label} in ${retryDelaySeconds}s`,
          cooldown: `${retryDelaySeconds}s`,
          swapsTotal: `${index + 1}/${sendRequests.length}`,
          swapsOk: String(completedTx),
          swapsFail: String(skippedTx)
        });

        await sleep(retryDelaySeconds * 1000);
      }
    }

    if (deferredState) {
      break;
    }

    completedTx++;

    // Record send pair for internal transfers to avoid reciprocal cooldowns
    if (sendRequest.source === "internal-round-robin" && senderAccountName && sendRequest.label) {
      recordSendPair(senderAccountName, sendRequest.label);
    }

    dashboard.setState({
      phase: "send",
      send: `${sendRequest.amount} CC -> ${sendRequest.label} (${progress})`,
      transfer: `${sendResult.status} | id=${sendResult.transferId || "n/a"} (${progress})`,
      swapsTotal: `${index + 1}/${sendRequests.length}`,
      swapsOk: String(completedTx),
      swapsFail: String(skippedTx)
    });

    // Delay between transactions (skip after last tx)
    if (index < sendRequests.length - 1 && delayTxMaxSec > 0) {
      const delayTxSec = randomIntInclusive(delayTxMinSec, delayTxMaxSec);
      console.log(`[info] Waiting ${delayTxSec}s before next tx...`);
      dashboard.setState({
        phase: "cooldown",
        cooldown: `${delayTxSec}s`,
        send: `Cooldown ${delayTxSec}s before next tx`
      });
      await sleep(delayTxSec * 1000);
    }
  }

  if (deferredState) {
    console.log(
      `[info] Batch deferred: reason=${deferredState.reason} retryAfter=${deferredState.retryAfterSeconds}s progress=${deferredState.progress}`
    );
    return {
      completedTx,
      skippedTx,
      deferred: true,
      deferReason: deferredState.reason,
      deferRetryAfterSeconds: deferredState.retryAfterSeconds,
      deferRequiredAmount: deferredState.requiredAmount,
      deferAvailableAmount: deferredState.availableAmount,
      deferProgress: deferredState.progress,
      deferSendLabel: deferredState.sendLabel
    };
  }

  // Final balance check (with timeout)
  stepLog(`[step] Refresh balances after send batch (timeout=${BALANCE_CHECK_TIMEOUT_MS}ms)`);
  const postSendBalance = await getBalanceWithTimeout(client);
  if (postSendBalance !== null) {
    dashboard.setState({
      balance: `CC=${postSendBalance.cc} | USDCx=${postSendBalance.usdcx} | CBTC=${postSendBalance.cbtc}`,
      swapsTotal: `${completedTx + skippedTx}/${sendRequests.length}`,
      swapsOk: String(completedTx),
      swapsFail: String(skippedTx),
      cooldown: "-"
    });
    console.log(`[info] Final balance: CC=${postSendBalance.cc} | Available=${postSendBalance.available}`);
  } else {
    console.log(`[warn] Final balance check timeout/failed`);
    dashboard.setState({
      swapsTotal: `${completedTx + skippedTx}/${sendRequests.length}`,
      swapsOk: String(completedTx),
      swapsFail: String(skippedTx),
      cooldown: "-"
    });
  }

  console.log(`[info] Batch summary: completed=${completedTx}, skipped=${skippedTx}, total=${sendRequests.length}`);
  return {
    completedTx,
    skippedTx,
    deferred: false,
    deferReason: null,
    deferRetryAfterSeconds: 0,
    deferRequiredAmount: null,
    deferAvailableAmount: null,
    deferProgress: null,
    deferSendLabel: null
  };
}

async function refreshVercelSecurityCookies(client, config, reasonLabel, onCheckpointRefresh) {
  console.log(`[info] ${reasonLabel}`);
  const browserCookies = await solveBrowserChallenge(
    config.baseUrl,
    config.paths.onboard,
    config.headers.userAgent,
    true
  );

  if (!browserCookies || browserCookies.size === 0) {
    throw new Error("Browser challenge did not return any cookies.");
  }

  client.mergeCookies(browserCookies);
  if (typeof onCheckpointRefresh === "function") {
    onCheckpointRefresh();
  }

  // Validate refreshed cookie against the same fetch path used by API client.
  try {
    await client.preflightOnboard();
    client.logCookieStatus("after refresh preflight");
  } catch (error) {
    console.log(`[warn] Refresh preflight still blocked: ${error.message}`);
  }
}

async function attemptSessionReuse(client, config, onCheckpointRefresh) {
  const maxCheckpointRefreshAttempts = Math.max(
    1,
    clampToNonNegativeInt(config.session.maxSessionReuseRefreshAttempts, 3)
  );
  const settleDelayMs = Math.max(
    0,
    clampToNonNegativeInt(config.session.checkpointSettleDelayMs, 3500)
  );

  let lastError = null;
  let attempt = 0;
  let checkpointRefreshAttempt = 0;

  while (true) {
    attempt += 1;
    try {
      // Step 1: Sync account (this validates session)
      console.log(`[info] Session reuse attempt ${attempt}: calling sync-account...`);
      const syncStart = Date.now();
      await client.syncAccount(config.paths.bridge);
      console.log(`[info] Session reuse attempt ${attempt}: sync-account OK (${Date.now() - syncStart}ms)`);
      
      // Step 2: Balance check (optional, timeout OK - session is still valid)
      console.log(`[info] Session reuse attempt ${attempt}: calling balances (timeout=15s)...`);
      const balanceStart = Date.now();
      
      let balancesData = {};
      try {
        const balancePromise = client.getBalances();
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Balance check timeout (15s)")), 15000);
        });
        
        const balancesResponse = await Promise.race([balancePromise, timeoutPromise]);
        balancesData = balancesResponse && balancesResponse.data ? balancesResponse.data : {};
        console.log(`[info] Session reuse attempt ${attempt}: balances OK (${Date.now() - balanceStart}ms)`);
      } catch (balanceError) {
        // Balance timeout is OK - session is still valid (sync-account passed)
        console.log(`[warn] Balance check failed: ${balanceError.message}`);
        console.log(`[info] Session is still valid (sync-account passed), continuing without balance data...`);
      }
      
      return {
        ok: true,
        balancesData
      };
    } catch (error) {
      console.log(`[info] Session reuse attempt ${attempt} failed: ${error.message}`);
      lastError = error;

      if (isSessionReuseTimeoutError(error)) {
        console.log(
          `[info] Session reuse timeout detected. Retrying in ${SESSION_REUSE_TIMEOUT_BACKOFF_SECONDS}s...`
        );
        await sleep(SESSION_REUSE_TIMEOUT_BACKOFF_SECONDS * 1000);
        continue;
      }

      if (
        isVercelCheckpointError(error) &&
        config.session.autoRefreshCheckpoint &&
        checkpointRefreshAttempt < maxCheckpointRefreshAttempts
      ) {
        checkpointRefreshAttempt += 1;
        await refreshVercelSecurityCookies(
          client,
          config,
          `Session reuse blocked by Vercel checkpoint (refresh ${checkpointRefreshAttempt}/${maxCheckpointRefreshAttempts}), refreshing browser security cookies...`,
          onCheckpointRefresh
        );
        client.logCookieStatus(`after session refresh attempt ${checkpointRefreshAttempt}`);
        if (settleDelayMs > 0) {
          console.log(`[info] Waiting ${settleDelayMs}ms for Vercel token settle before retry...`);
          await sleep(settleDelayMs);
        }
        continue;
      }

      return {
        ok: false,
        error
      };
    }
  }
}

async function sendOtpWithCheckpointRecovery(client, selectedEmail, config, onCheckpointRefresh) {
  const maxAttempts = Math.max(
    1,
    clampToNonNegativeInt(config.session.maxOtpRefreshAttempts, 3)
  );
  const settleDelayMs = Math.max(
    0,
    clampToNonNegativeInt(config.session.checkpointSettleDelayMs, 3500)
  );

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.sendOtp(selectedEmail);
    } catch (error) {
      lastError = error;
      if (
        !isVercelCheckpointError(error) ||
        !config.session.autoRefreshCheckpoint ||
        attempt >= maxAttempts
      ) {
        throw error;
      }

      await refreshVercelSecurityCookies(
        client,
        config,
        `Send OTP blocked by Vercel checkpoint (attempt ${attempt}/${maxAttempts}), refreshing browser security cookies...`,
        onCheckpointRefresh
      );
      client.logCookieStatus(`after refresh before send-otp retry ${attempt}`);
      if (settleDelayMs > 0) {
        console.log(`[info] Waiting ${settleDelayMs}ms for Vercel token settle before send-otp retry...`);
        await sleep(settleDelayMs);
      }
    }
  }

  throw lastError || new Error("Send OTP failed after refresh retries");
}

async function processAccount(context) {
  const {
    account,
    accountToken,
    config,
    tokens,
    tokensPath,
    sendMode,
    recipientsInfo,
    args,
    accountIndex,
    totalAccounts,
    selectedAccounts,
    accountSnapshots,
    loopRound,
    totalLoopRounds,
    maxLoopTxOverride
  } = context;

  const selectedEmail = String(process.env.ROOTSFI_EMAIL || account.email).trim();
  if (!selectedEmail || !selectedEmail.includes("@")) {
    throw new Error(`Account ${account.name}: email is invalid`);
  }
  const accountLogTag = `A${accountIndex + 1}/${totalAccounts}`;

  const selectedAccountList =
    Array.isArray(selectedAccounts) && selectedAccounts.length > 0
      ? selectedAccounts
      : [{ name: account.name, email: selectedEmail }];
  const accountRows = selectedAccountList
    .map((entry, idx) => {
      const entryName = String(entry && entry.name ? entry.name : `Account ${idx + 1}`);

      let marker = "queue";
      if (idx < accountIndex) {
        marker = "done";
      } else if (idx === accountIndex) {
        marker = "run";
      }

      return `*${entryName}(${marker})`;
    })
    .join(" | ");
  const accountConfig = cloneRuntimeConfig(config);
  const configuredMaxLoopTx = clampToNonNegativeInt(
    accountConfig.send.maxLoopTx || accountConfig.send.maxTx,
    1
  );
  const effectiveMaxLoopTx = Number.isFinite(Number(maxLoopTxOverride))
    ? Math.max(1, clampToNonNegativeInt(maxLoopTxOverride, 1))
    : configuredMaxLoopTx;
  accountConfig.send.maxLoopTx = effectiveMaxLoopTx;

  const cycleLoopRounds = Math.max(
    1,
    clampToNonNegativeInt(totalLoopRounds, configuredMaxLoopTx)
  );
  const accountTargetPerDay =
    cycleLoopRounds *
    Math.max(1, selectedAccountList.length);
  const defaultMinCooldownSeconds = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(accountConfig.send, "minDelayTxSeconds")
      ? accountConfig.send.minDelayTxSeconds
      : accountConfig.send.delayTxSeconds,
    INTERNAL_API_DEFAULTS.send.minDelayTxSeconds
  );
  const defaultMaxCooldownSeconds = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(accountConfig.send, "maxDelayTxSeconds")
      ? accountConfig.send.maxDelayTxSeconds
      : accountConfig.send.delayTxSeconds,
    INTERNAL_API_DEFAULTS.send.maxDelayTxSeconds
  );
  const cooldownLabel = defaultMaxCooldownSeconds > defaultMinCooldownSeconds
    ? `${defaultMinCooldownSeconds}-${defaultMaxCooldownSeconds}s`
    : `${defaultMinCooldownSeconds}s`;

  // Apply token profile to config for this account
  applyTokenProfileToConfig(accountConfig, accountToken);

  let checkpointRefreshCount = 0;
  let lastVercelRefreshAt = String(accountToken.security.lastVercelRefreshAt || "").trim();
  const markCheckpointRefresh = () => {
    checkpointRefreshCount += 1;
    lastVercelRefreshAt = new Date().toISOString();
  };

  const dashboard = new PinnedDashboard({
    enabled:
      accountConfig.ui.dashboard &&
      !args.noDashboard &&
      process.env.ROOTSFI_NO_DASHBOARD !== "1",
    logLines: accountConfig.ui.logLines,
    accountSnapshots
  });

  const initialDashboardState = {
    phase: "init",
    selectedAccount: `[${accountIndex + 1}/${totalAccounts}] ${account.name} (${maskEmail(selectedEmail)})`,
    accounts: accountRows,
    targetPerDay: String(accountTargetPerDay),
    cooldown: cooldownLabel,
    swapsTotal: "0/0",
    swapsOk: "0",
    swapsFail: "0"
  };
  dashboard.setState(initialDashboardState);
  dashboard.attach();

  const updateCookieDashboard = (client, phase) => {
    const status = client.getCookieStatus();
    const patch = {
      cookie: `_vcrcs=${status.security} session=${status.session} total=${status.total}`
    };

    if (phase) {
      patch.phase = phase;
    }

    dashboard.setState(patch);
  };

  try {
    const currentRound = Math.max(1, clampToNonNegativeInt(loopRound, 1));
    const roundLabel = totalLoopRounds > 1 ? ` | Round ${currentRound}/${totalLoopRounds}` : "";
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[account ${accountIndex + 1}/${totalAccounts}] Processing: ${account.name} (${maskEmail(selectedEmail)})${roundLabel}`);
    console.log(`${"=".repeat(60)}`);

    console.log(
      `[init] Token profile ready: deviceId=${maskSecret(accountToken.deviceId, 6, 6)} antiBot=${maskSecret(accountToken.security.antiBotNonce, 6, 6)}`
    );

    const sendPolicy = accountConfig.send;

    // Build send requests based on mode
    let sendRequests = [];
    if (sendMode === "external") {
      if (recipientsInfo.missing || recipientsInfo.recipients.length === 0) {
        throw new Error("External mode requires recipient.txt with valid recipients");
      }

      if (!sendPolicy.randomAmount.enabled) {
        throw new Error("External mode requires config.send.randomAmount.enabled=true");
      }

      // Build requests with random recipient per TX
      sendRequests = buildSendRequestsWithRandomRecipients(recipientsInfo.recipients, sendPolicy);

      const amountLabel = `${sendPolicy.randomAmount.min}-${sendPolicy.randomAmount.max} (random)`;
      const recipientsList = sendRequests.map(r => r.label).join(", ");
      dashboard.setState({
        send: `${amountLabel} CC x${sendRequests.length} -> random recipients`,
        mode: "external"
      });
      console.log(`[init] Send plan: ${amountLabel} CC x${sendRequests.length} -> [${recipientsList}]`);
    } else if (sendMode === "internal") {
      // Internal mode - one-directional ring strategy (parallel execution)
      // Each account sends to next account in sorted ring: A->B, B->C, C->A
      if (!sendPolicy.randomAmount.enabled) {
        throw new Error("Internal mode requires config.send.randomAmount.enabled=true");
      }

      // Build single request using ring strategy (one TX per account per round)
      const singleRequest = buildInternalSendRequest(
        selectedAccounts,
        account.name,
        sendPolicy
      );

      const amountLabel = `${sendPolicy.randomAmount.min}-${sendPolicy.randomAmount.max} (random)`;
      
      if (!singleRequest) {
        // Should not happen with valid config, but handle gracefully
        console.log(`[ring] ${account.name}: No recipient available (config issue?)`);
        dashboard.setState({
          send: `No recipient available`,
          mode: "internal",
          phase: "skip"
        });
        
        return {
          success: true,
          account: account.name,
          mode: "internal-skip",
          deferred: false,
          deferReason: null,
          deferRetryAfterSeconds: 0,
          deferRequiredAmount: null,
          deferAvailableAmount: null,
          txCompleted: 0,
          txSkipped: 1
        };
      }
      
      // Wrap single request in array for executeSendBatch compatibility
      sendRequests = [singleRequest];
      
      dashboard.setState({
        send: `${singleRequest.amount} CC -> ${singleRequest.label}`,
        mode: "internal-ring"
      });
      console.log(`[init] Send plan (ring): ${singleRequest.amount} CC -> ${singleRequest.label}`);
    } else {
      dashboard.setState({ mode: "balance-only" });
      console.log("[init] Balance check only mode");
    }

    if (args.dryRun) {
      dashboard.setState({ phase: "dry-run" });
      console.log("[dry-run] Configuration parsed successfully. No API requests were sent.");
      return {
        success: true,
        account: account.name,
        mode: "dry-run",
        deferred: false,
        deferReason: null,
        deferRetryAfterSeconds: 0,
        deferRequiredAmount: null,
        deferAvailableAmount: null,
        txCompleted: 0,
        txSkipped: 0
      };
    }

    const client = new RootsFiApiClient(accountConfig);
    updateCookieDashboard(client, "startup");
    client.logCookieStatus("startup");

    if (accountConfig.session.preflightOnboard) {
      dashboard.setState({ phase: "preflight" });
      console.log(withAccountTag(accountLogTag, "[step] Preflight onboard page"));
      try {
        await client.preflightOnboard();
        console.log(withAccountTag(accountLogTag, "[step] Preflight onboard done"));
      } catch (error) {
        console.log(`[warn] Preflight failed: ${error.message}`);
      }
    }

    if (shouldRefreshVercelCookie(lastVercelRefreshAt, accountConfig.session.proactiveVercelRefreshMinutes)) {
      dashboard.setState({ phase: "vercel-refresh" });
      console.log(
        withAccountTag(
          accountLogTag,
          `[step] Proactive Vercel cookie refresh (interval=${accountConfig.session.proactiveVercelRefreshMinutes}m)`
        )
      );
      try {
        await refreshVercelSecurityCookies(
          client,
          accountConfig,
          "Proactive refresh started",
          markCheckpointRefresh
        );
        client.logCookieStatus("after proactive refresh");
        updateCookieDashboard(client);
      } catch (error) {
        console.log(`[warn] Proactive refresh failed: ${error.message}`);
      }
    }

    if (!client.hasValidSession()) {
      dashboard.setState({ phase: "browser-checkpoint" });
      console.log("[info] No valid session cookies found, launching browser...");
      await refreshVercelSecurityCookies(
        client,
        accountConfig,
        "Initial browser verification required",
        markCheckpointRefresh
      );
      console.log("[info] Browser cookies merged from challenge flow");
      client.logCookieStatus("after browser merge");
      updateCookieDashboard(client);
    } else {
      console.log("[info] Using existing session cookies from tokens.json");
    }

    // Prefer existing authenticated session and only use OTP flow when session is not reusable.
    if (client.hasAccountSessionCookie()) {
      dashboard.setState({ phase: "session-reuse" });
      console.log(withAccountTag(accountLogTag, "[step] Attempt existing session (skip OTP)"));
      const sessionReuse = await attemptSessionReuse(client, accountConfig, markCheckpointRefresh);
      updateCookieDashboard(client);

      if (sessionReuse.ok) {
        const balance = printBalanceSummary(sessionReuse.balancesData);
        dashboard.setState({
          balance: `CC=${balance.cc} | USDCx=${balance.usdcx} | CBTC=${balance.cbtc}`
        });

        await refreshThisWeekRewardDashboard(client, dashboard, accountLogTag);

        let sendBatchResult = {
          completedTx: 0,
          skippedTx: 0,
          deferred: false,
          deferReason: null,
          deferRetryAfterSeconds: 0
        };

        if (sendRequests.length > 0) {
          sendBatchResult = await executeSendBatch(
            client,
            sendRequests,
            accountConfig,
            dashboard,
            markCheckpointRefresh,
            accountLogTag,
            account.name // senderAccountName for pair tracking
          );

          // Accumulate global and per-account TX stats
          const batchCompleted = clampToNonNegativeInt(sendBatchResult.completedTx, 0);
          const batchFailed = clampToNonNegativeInt(sendBatchResult.skippedTx, 0);
          addGlobalTxStats(batchCompleted, batchFailed);
          addPerAccountTxStats(account.name, batchCompleted, batchFailed);

          // Update dashboard banner with global totals
          dashboard.setState({
            swapsTotal: globalSwapsTotal,
            swapsOk: globalSwapsOk,
            swapsFail: globalSwapsFail
          });
        }

        client.logCookieStatus("after session reuse");
        updateCookieDashboard(client, "session-reused");
        console.log("[done] Login and balance check completed using existing session.");

        tokens.accounts[account.name] = applyClientStateToTokenProfile(
          accountToken,
          client,
          checkpointRefreshCount,
          lastVercelRefreshAt
        );
        await saveTokensSerial(tokensPath, tokens);
        console.log("[info] Session/header/device/security saved to tokens.json");
        return {
          success: true,
          account: account.name,
          mode: "session-reuse",
          deferred: Boolean(sendBatchResult.deferred),
          deferReason: sendBatchResult.deferReason || null,
          deferRetryAfterSeconds: clampToNonNegativeInt(
            sendBatchResult.deferRetryAfterSeconds,
            TX_RETRY_INITIAL_DELAY_SECONDS
          ),
          deferRequiredAmount: sendBatchResult.deferRequiredAmount,
          deferAvailableAmount: sendBatchResult.deferAvailableAmount,
          txCompleted: clampToNonNegativeInt(sendBatchResult.completedTx, 0),
          txSkipped: clampToNonNegativeInt(sendBatchResult.skippedTx, 0)
        };
      }

      const sessionError = sessionReuse.error;
      if (isVercelCheckpointError(sessionError)) {
        tokens.accounts[account.name] = applyClientStateToTokenProfile(
          accountToken,
          client,
          checkpointRefreshCount,
          lastVercelRefreshAt
        );
        await saveTokensSerial(tokensPath, tokens);
        console.log("[info] Latest refreshed security cookies saved to tokens.json");

        if (!accountConfig.session.fallbackToOtpOnPersistentCheckpoint) {
          throw new Error(
            "Existing session still blocked by Vercel Security Checkpoint after refresh attempts. " +
              "Fallback to OTP is disabled by config.session.fallbackToOtpOnPersistentCheckpoint=false."
          );
        }

        dashboard.setState({ phase: "otp-fallback" });
        console.log(
          "[warn] Existing session still blocked by Vercel checkpoint after refresh attempts. Falling back to OTP flow as last resort."
        );

        // Force fresh browser challenge before OTP fallback to get valid security cookies
        console.log(withAccountTag(accountLogTag, "[step] Force fresh browser challenge before OTP fallback..."));
        await refreshVercelSecurityCookies(
          client,
          accountConfig,
          "Fresh browser verification for OTP fallback",
          markCheckpointRefresh
        );
        client.logCookieStatus("after fresh browser for OTP fallback");
        updateCookieDashboard(client);

        const settleDelayMs = Math.max(
          0,
          clampToNonNegativeInt(accountConfig.session.checkpointSettleDelayMs, 3500)
        );
        if (settleDelayMs > 0) {
          console.log(`[info] Waiting ${settleDelayMs}ms before OTP fallback...`);
          await sleep(settleDelayMs);
        }
      } else {
        if (isInvalidSessionError(sessionError)) {
          console.log(`[info] Existing session is invalid: ${sessionError.message}`);
          console.log("[info] Falling back to OTP login flow.");
        } else {
          throw new Error(
            `Existing session is not reusable but not marked invalid-session: ${sessionError.message}`
          );
        }
      }
    }

    dashboard.setState({ phase: "otp-send" });
    console.log(withAccountTag(accountLogTag, "[step] Send OTP"));
    const sendOtpResponse = await sendOtpWithCheckpointRecovery(
      client,
      selectedEmail,
      accountConfig,
      markCheckpointRefresh
    );
    updateCookieDashboard(client);
    const otpId = sendOtpResponse && sendOtpResponse.data ? sendOtpResponse.data.otpId : null;

    if (!otpId) {
      throw new Error("send-otp did not return otpId");
    }

    console.log(`[info] OTP sent to ${maskEmail(selectedEmail)} | otpId=${maskSecret(otpId, 8, 6)}`);

    const otpCode = await promptOtpCode();

    if (!/^\d{4,8}$/.test(otpCode)) {
      throw new Error("OTP format must be numeric (4 to 8 digits)");
    }

    dashboard.setState({ phase: "otp-verify" });
    console.log(withAccountTag(accountLogTag, "[step] Verify OTP"));
    const verifyResponse = await client.verifyOtp({
      email: selectedEmail,
      otpId,
      otpCode
    });

    const nextStep = verifyResponse && verifyResponse.data ? verifyResponse.data.nextStep : null;
    console.log(`[info] verify-otp nextStep: ${nextStep || "unknown"}`);

    dashboard.setState({ phase: "sync-onboard" });
    console.log(withAccountTag(accountLogTag, "[step] Sync account (onboard referer)"));
    await client.syncAccount(accountConfig.paths.onboard);

    const pendingAfterVerify = await client.getPending(accountConfig.paths.onboard);
    const pendingData = pendingAfterVerify && pendingAfterVerify.data ? pendingAfterVerify.data : {};
    console.log(`[info] Pending after verify: ${Boolean(pendingData.pending)}`);

    if (pendingData.pending) {
      if (pendingData.alreadyActive === true) {
        dashboard.setState({ phase: "finalize-returning" });
        console.log(withAccountTag(accountLogTag, "[step] Finalize returning account"));
        const finalizeResponse = await client.finalizeReturning();
        const username = finalizeResponse && finalizeResponse.data ? finalizeResponse.data.username : pendingData.existingUsername;
        console.log(`[info] Finalized returning user: ${username || "unknown"}`);
      } else {
        throw new Error(
          "Account still in pending state and not marked alreadyActive. This script currently handles returning-account flow."
        );
      }
    }

    dashboard.setState({ phase: "sync-bridge" });
    console.log(withAccountTag(accountLogTag, "[step] Sync account (bridge referer)"));
    await client.syncAccount(accountConfig.paths.bridge);

    dashboard.setState({ phase: "balances" });
    console.log(withAccountTag(accountLogTag, "[step] Get balances"));
    const balancesResponse = await client.getBalances();
    const balance = printBalanceSummary(balancesResponse && balancesResponse.data ? balancesResponse.data : {});
    dashboard.setState({
      balance: `CC=${balance.cc} | USDCx=${balance.usdcx} | CBTC=${balance.cbtc}`
    });

    await refreshThisWeekRewardDashboard(client, dashboard, accountLogTag);

    let sendBatchResult = {
      completedTx: 0,
      skippedTx: 0,
      deferred: false,
      deferReason: null,
      deferRetryAfterSeconds: 0
    };

    if (sendRequests.length > 0) {
      sendBatchResult = await executeSendBatch(
        client,
        sendRequests,
        accountConfig,
        dashboard,
        markCheckpointRefresh,
        accountLogTag,
        account.name // senderAccountName for pair tracking
      );

      // Accumulate global and per-account TX stats
      const batchCompleted = clampToNonNegativeInt(sendBatchResult.completedTx, 0);
      const batchFailed = clampToNonNegativeInt(sendBatchResult.skippedTx, 0);
      addGlobalTxStats(batchCompleted, batchFailed);
      addPerAccountTxStats(account.name, batchCompleted, batchFailed);

      // Update dashboard banner with global totals
      dashboard.setState({
        swapsTotal: globalSwapsTotal,
        swapsOk: globalSwapsOk,
        swapsFail: globalSwapsFail
      });
    }

    client.logCookieStatus("after login flow");
    updateCookieDashboard(client, "completed");
    if (!client.hasAccountSessionCookie()) {
      console.log(
        "[warn] cantonbridge_session is not present in cookie jar yet. This can happen if runtime does not expose set-cookie headers."
      );
    }

    console.log("[done] Login and balance check completed.");

    tokens.accounts[account.name] = applyClientStateToTokenProfile(
      accountToken,
      client,
      checkpointRefreshCount,
      lastVercelRefreshAt
    );
    await saveTokensSerial(tokensPath, tokens);
    console.log("[info] Session/header/device/security saved to tokens.json");

    return {
      success: true,
      account: account.name,
      mode: "otp-login",
      deferred: Boolean(sendBatchResult.deferred),
      deferReason: sendBatchResult.deferReason || null,
      deferRetryAfterSeconds: clampToNonNegativeInt(
        sendBatchResult.deferRetryAfterSeconds,
        TX_RETRY_INITIAL_DELAY_SECONDS
      ),
      deferRequiredAmount: sendBatchResult.deferRequiredAmount,
      deferAvailableAmount: sendBatchResult.deferAvailableAmount,
      txCompleted: clampToNonNegativeInt(sendBatchResult.completedTx, 0),
      txSkipped: clampToNonNegativeInt(sendBatchResult.skippedTx, 0)
    };
  } finally {
    dashboard.detach();
  }
}

function getNextMidnightUTC() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return tomorrow;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function formatUTCTime(date) {
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function runDailyCycle(context) {
  const {
    config,
    accounts,
    tokens,
    tokensPath,
    sendMode,
    recipientsInfo,
    args
  } = context;

  const cycleStartTime = new Date();
  
  // Reset round-robin offset untuk daily cycle baru
  resetRoundRobinOffset();
  
  // Reset global TX stats untuk daily cycle baru
  resetGlobalTxStats();
  
  // Clean up expired send pairs (legacy - not used in ring strategy)
  cleanupExpiredSendPairs();
  
  // Sort accounts for consistent ring order (NO SHUFFLE - predictable pattern)
  const sortedAccounts = [...accounts.accounts].sort((a, b) => 
    a.name.localeCompare(b.name)
  );
  
  console.log(`\n${"#".repeat(70)}`);
  console.log(`[cycle] Loop cycle started at ${formatUTCTime(cycleStartTime)}`);
  console.log(`[cycle] Mode: ${sendMode} | Accounts: ${sortedAccounts.length}`);
  console.log(`[ring] Strategy: ONE-DIRECTIONAL RING with PARALLEL EXECUTION`);
  console.log(`[ring] Pattern: A->B, B->C, C->A (all accounts send simultaneously)`);
  console.log(`${"#".repeat(70)}\n`);

  const results = [];
  const totalAccounts = sortedAccounts.length;
  const configuredMaxLoopTx = clampToNonNegativeInt(config.send.maxLoopTx || config.send.maxTx, 1);
  const totalLoopRounds = sendMode === "balance-only" ? 1 : configuredMaxLoopTx;
  
  // Parallel jitter: random delay for each account before starting (staggered start)
  // This prevents all accounts hitting the server at exact same millisecond
  const minParallelJitterSec = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(config.send, "minDelayTxSeconds")
      ? config.send.minDelayTxSeconds
      : config.send.delayTxSeconds,
    INTERNAL_API_DEFAULTS.send.minDelayTxSeconds
  );
  const maxParallelJitterSec = clampToNonNegativeInt(
    Object.prototype.hasOwnProperty.call(config.send, "maxDelayTxSeconds")
      ? config.send.maxDelayTxSeconds
      : config.send.delayTxSeconds,
    INTERNAL_API_DEFAULTS.send.maxDelayTxSeconds
  );
  const parallelJitterMinSec = Math.min(minParallelJitterSec, maxParallelJitterSec);
  const parallelJitterMaxSec = Math.max(minParallelJitterSec, maxParallelJitterSec);
  
  // Round delay: fixed delay between rounds
  const delayRoundSec = clampToNonNegativeInt(
    config.send.delayCycleSeconds,
    INTERNAL_API_DEFAULTS.send.delayCycleSeconds
  );
  
  const accountSnapshots = {};
  const roundDeferPollSeconds = TX_RETRY_INITIAL_DELAY_SECONDS;

  // Display ring order (consistent, not shuffled)
  const ringOrderLabel = sortedAccounts.map((item) => item.name).join(" -> ");
  console.log(`[ring] Fixed ring order: ${ringOrderLabel}`);
  console.log(`[cycle] Loop rounds: ${totalLoopRounds} (maxLoopTx=${configuredMaxLoopTx})`);
  console.log(`[cycle] Parallel jitter: ${parallelJitterMinSec}-${parallelJitterMaxSec}s per account`);
  console.log(`[cycle] Round delay: ${delayRoundSec}s between rounds\n`);

  for (let roundIndex = 0; roundIndex < totalLoopRounds; roundIndex += 1) {
    const loopRound = roundIndex + 1;
    
    // Round Robin: increment offset (legacy, but kept for consistency)
    incrementRoundRobinOffset();
    
    const maxDeferPassesPerRound = Math.max(3, sortedAccounts.length * 4);
    
    // Round 1 is SEQUENTIAL (to handle OTP/login prompts one by one)
    // Round 2+ is PARALLEL (sessions already established)
    const isSequentialRound = (loopRound === 1);
    const executionMode = isSequentialRound ? "SEQUENTIAL (auth/OTP)" : "PARALLEL";
    
    console.log(`\n[cycle] Round ${loopRound}/${totalLoopRounds} started (${executionMode})`);

    let pendingEntries = sortedAccounts.map((account) => ({
      account,
      deferUntilMs: 0,
      deferReason: "",
      debtTurns: 0
    }));
    let deferPassCount = 0;

    while (pendingEntries.length > 0) {
      deferPassCount += 1;
      const nowMs = Date.now();
      const readyEntries = [];
      const delayedEntries = [];

      for (const entry of pendingEntries) {
        if (!args.dryRun && entry.deferUntilMs > nowMs) {
          delayedEntries.push(entry);
        } else {
          readyEntries.push(entry);
        }
      }

      if (readyEntries.length === 0) {
        const nearestReadyMs = delayedEntries.reduce(
          (minValue, entry) => Math.min(minValue, entry.deferUntilMs || nowMs),
          Number.MAX_SAFE_INTEGER
        );
        const waitMs = Math.max(0, nearestReadyMs - nowMs);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        const waitingNames = delayedEntries.map((entry) => entry.account.name).join(", ");
        console.log(
          `[cycle] Round ${loopRound}/${totalLoopRounds} waiting ${waitSeconds}s for deferred accounts: ${waitingNames}`
        );
        if (!args.dryRun) {
          await sleep(waitSeconds * 1000);
        }
        pendingEntries = delayedEntries;
        continue;
      }

      if (deferPassCount > 1) {
        const retryOrder = readyEntries.map((entry) => entry.account.name).join(", ");
        console.log(
          `[cycle] Round ${loopRound}/${totalLoopRounds} deferred retry pass #${deferPassCount} | accounts: ${retryOrder}`
        );
      }

      // ========================================================================
      // EXECUTION MODE: Sequential for Round 1, Parallel for Round 2+
      // ========================================================================
      
      let roundResults = [];
      
      if (isSequentialRound) {
        // ====================================================================
        // SEQUENTIAL EXECUTION (Round 1): Process accounts one by one
        // This allows proper OTP input without prompts overlapping
        // ====================================================================
        const sequentialAccounts = readyEntries.map((e) => e.account.name).join(" -> ");
        console.log(`[sequential] Processing ${readyEntries.length} accounts one by one: ${sequentialAccounts}`);
        
        for (let i = 0; i < readyEntries.length; i++) {
          const entry = readyEntries[i];
          const account = entry.account;
          const accountToken = tokens.accounts[account.name] || normalizeTokenProfile({});
          tokens.accounts[account.name] = accountToken;

          console.log(`[sequential] [${i + 1}/${readyEntries.length}] Processing ${account.name}...`);

          try {
            const result = await processAccount({
              account,
              accountToken,
              config,
              tokens,
              tokensPath,
              sendMode,
              recipientsInfo,
              args,
              accountIndex: i,
              totalAccounts,
              selectedAccounts: sortedAccounts,
              accountSnapshots,
              loopRound,
              totalLoopRounds,
              maxLoopTxOverride: sendMode === "balance-only" ? null : 1
            });
            roundResults.push({ entry, result, error: null });
          } catch (error) {
            console.error(`[error] Round ${loopRound}/${totalLoopRounds} | Account ${account.name}: ${error.message}`);
            roundResults.push({ 
              entry, 
              result: { success: false, account: account.name }, 
              error: error.message 
            });
          }

          // Small delay between sequential accounts (not the full jitter)
          if (i < readyEntries.length - 1 && !args.dryRun) {
            const seqDelaySec = 2; // 2 seconds between sequential accounts
            console.log(`[sequential] Waiting ${seqDelaySec}s before next account...`);
            await sleep(seqDelaySec * 1000);
          }
        }
      } else {
        // ====================================================================
        // PARALLEL EXECUTION (Round 2+): All accounts send with staggered jitter
        // Sessions should already be established from Round 1
        // ====================================================================
        const parallelAccounts = readyEntries.map((e) => e.account.name).join(", ");
        console.log(`[parallel] Executing ${readyEntries.length} accounts with jitter ${parallelJitterMinSec}-${parallelJitterMaxSec}s: ${parallelAccounts}`);
        
        const accountPromises = readyEntries.map(async (entry, i) => {
          const account = entry.account;
          const accountToken = tokens.accounts[account.name] || normalizeTokenProfile({});
          tokens.accounts[account.name] = accountToken;

          // Apply random jitter before starting this account (staggered parallel)
          if (!args.dryRun && parallelJitterMaxSec > 0) {
            const jitterSec = randomIntInclusive(parallelJitterMinSec, parallelJitterMaxSec);
            if (jitterSec > 0) {
              console.log(`[parallel] ${account.name} waiting ${jitterSec}s jitter before start`);
              await sleep(jitterSec * 1000);
            }
          }

          try {
            const result = await processAccount({
              account,
              accountToken,
              config,
              tokens,
              tokensPath,
              sendMode,
              recipientsInfo,
              args,
              accountIndex: i,
              totalAccounts,
              selectedAccounts: sortedAccounts,
              accountSnapshots,
              loopRound,
              totalLoopRounds,
              maxLoopTxOverride: sendMode === "balance-only" ? null : 1
            });
            return { entry, result, error: null };
          } catch (error) {
            console.error(`[error] Round ${loopRound}/${totalLoopRounds} | Account ${account.name}: ${error.message}`);
            return { 
              entry, 
              result: { success: false, account: account.name }, 
              error: error.message 
            };
          }
        });
        
        // Wait for all parallel executions to complete
        roundResults = await Promise.all(accountPromises);
      }
      
      // Process results
      let passMadeProgress = false;
      const nextPendingEntries = delayedEntries.slice();
      
      for (const { entry, result, error } of roundResults) {
        if (error) {
          results.push({ success: false, account: entry.account.name, round: loopRound, error });
          continue;
        }
        
        results.push({ ...result, round: loopRound });

        if (result && result.deferred && sendMode !== "balance-only") {
          const retryAfterSeconds = Math.max(
            1,
            clampToNonNegativeInt(result.deferRetryAfterSeconds, roundDeferPollSeconds)
          );
          const deferUntilMs = Date.now() + (retryAfterSeconds * 1000);
          const requiredLabel = Number.isFinite(Number(result.deferRequiredAmount))
            ? `need=${result.deferRequiredAmount}`
            : "need=n/a";
          const availableLabel = Number.isFinite(Number(result.deferAvailableAmount))
            ? `have=${result.deferAvailableAmount}`
            : "have=n/a";
          console.log(
            `[cycle] Deferred ${entry.account.name}: reason=${result.deferReason || "temporary"} ${requiredLabel} ${availableLabel} retry=${retryAfterSeconds}s`
          );
          nextPendingEntries.push({
            account: entry.account,
            deferUntilMs,
            deferReason: result.deferReason || "temporary",
            debtTurns: (entry.debtTurns || 0) + 1
          });
        } else {
          passMadeProgress = true;
        }
      }
      
      // No delay between accounts in parallel execution (they already ran simultaneously)

      if (nextPendingEntries.length === 0) {
        pendingEntries = [];
        break;
      }

      nextPendingEntries.sort((left, right) => {
        const debtDiff = (right.debtTurns || 0) - (left.debtTurns || 0);
        if (debtDiff !== 0) {
          return debtDiff;
        }

        const deferDiff = (left.deferUntilMs || 0) - (right.deferUntilMs || 0);
        return deferDiff;
      });

      if (!passMadeProgress) {
        if (deferPassCount >= maxDeferPassesPerRound) {
          const unresolvedNames = nextPendingEntries.map((entry) => entry.account.name).join(", ");
          console.warn(
            `[warn] Round ${loopRound}/${totalLoopRounds} reached defer pass limit (${maxDeferPassesPerRound}). Carry unresolved to next round: ${unresolvedNames}`
          );
          for (const unresolved of nextPendingEntries) {
            results.push({
              success: false,
              account: unresolved.account.name,
              round: loopRound,
              deferred: true,
              error: `Deferred unresolved in round ${loopRound}`
            });
          }
          pendingEntries = [];
          break;
        }

        const nowAfterPassMs = Date.now();
        const nearestReadyMs = nextPendingEntries.reduce((minValue, entry) => {
          const candidate = entry.deferUntilMs || (nowAfterPassMs + (roundDeferPollSeconds * 1000));
          return Math.min(minValue, candidate);
        }, Number.MAX_SAFE_INTEGER);
        const waitMs = Math.max(0, nearestReadyMs - nowAfterPassMs);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        console.log(
          `[cycle] Round ${loopRound}/${totalLoopRounds} has no send progress. Waiting ${waitSeconds}s before retrying deferred accounts...`
        );
        if (!args.dryRun) {
          await sleep(waitSeconds * 1000);
        }
      }

      pendingEntries = nextPendingEntries;
    }

    // Fixed delay between rounds (delayCycleSeconds)
    if (
      roundIndex < totalLoopRounds - 1 &&
      sendMode !== "balance-only" &&
      delayRoundSec > 0 &&
      !args.dryRun
    ) {
      console.log(
        `[cycle] Round ${loopRound}/${totalLoopRounds} completed. Waiting ${delayRoundSec}s before next round...`
      );
      await sleep(delayRoundSec * 1000);
    }
  }

  const cycleEndTime = new Date();
  const cycleDuration = cycleEndTime - cycleStartTime;
  
  const successful = results.filter((r) => r.success && !r.deferred);
  const failed = results.filter(r => !r.success);

  return { results, successful, failed, cycleDuration };
}

async function run() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. Use Node.js 18+.");
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const configPath = path.resolve(process.cwd(), args.configFile);
  const accountsPath = path.resolve(process.cwd(), args.accountsFile);
  const tokensPath = path.resolve(process.cwd(), args.tokensFile);

  const [rawConfig, rawAccounts, rawTokens] = await Promise.all([
    readJson(configPath, "config"),
    readJson(accountsPath, "accounts"),
    readOptionalJson(tokensPath, "tokens")
  ]);

  const config = normalizeConfig(rawConfig);
  const accounts = normalizeAccounts(rawAccounts);
  const legacyCookies = extractLegacyAccountCookies(rawAccounts);
  const tokens = normalizeTokens(rawTokens, accounts);

  for (const accountEntry of accounts.accounts) {
    const profile = tokens.accounts[accountEntry.name] || normalizeTokenProfile({});
    if (!String(profile.cookie || "").trim() && legacyCookies.has(accountEntry.name)) {
      profile.cookie = legacyCookies.get(accountEntry.name);
    }
    tokens.accounts[accountEntry.name] = profile;
  }

  // Keep generated token file in sync with current accounts and token schema.
  await saveTokensSerial(tokensPath, tokens);

  // Load recipients
  const recipientsInfo = await loadRecipients(config.recipientFile);
  if (recipientsInfo.missing) {
    console.log(`[warn] Recipient file not found: ${recipientsInfo.absolutePath}`);
  } else {
    console.log(`[init] Recipients loaded: ${recipientsInfo.recipients.length}`);
    if (recipientsInfo.invalidLines.length > 0) {
      console.log(`[warn] Invalid recipient rows: ${recipientsInfo.invalidLines.length}`);
    }
  }

  // Show accounts summary
  console.log(`[init] Total accounts: ${accounts.accounts.length}`);
  for (const acc of accounts.accounts) {
    const tokenProfile = tokens.accounts[acc.name];
    const hasToken = tokenProfile && String(tokenProfile.cookie || "").trim();
    console.log(`  - ${acc.name} (${maskEmail(acc.email)}) [${hasToken ? "has-token" : "no-token"}]`);
  }

  // Prompt for send mode
  const sendMode = await promptSendMode();
  console.log(`\n[init] Selected mode: ${sendMode}`);

  if (sendMode === "external" && (recipientsInfo.missing || recipientsInfo.recipients.length === 0)) {
    throw new Error("External mode requires recipient.txt with valid recipients");
  }

  // Validate internal mode - check accounts have addresses
  if (sendMode === "internal") {
    const accountsWithAddress = accounts.accounts.filter(acc => String(acc.address || "").trim());
    if (accountsWithAddress.length < 2) {
      throw new Error("Internal mode requires at least 2 accounts with 'address' field in accounts.json. Please fill in the cantonPartyId for each account.");
    }
    console.log(`[init] Accounts with address: ${accountsWithAddress.length}/${accounts.accounts.length}`);
    
    const missingAddress = accounts.accounts.filter(acc => !String(acc.address || "").trim());
    if (missingAddress.length > 0) {
      console.log(`[warn] Accounts without address (will be skipped): ${missingAddress.map(a => a.name).join(", ")}`);
    }
  }

  // Prompt for account selection (for external and balance-only modes)
  // For internal mode, use all accounts with valid addresses
  let selectedAccounts = accounts.accounts;
  if (sendMode === "external" || sendMode === "balance-only") {
    const accountSelection = await promptAccountSelection(accounts.accounts);
    selectedAccounts = accountSelection.selectedAccounts;
    
    const accountNames = selectedAccounts.map(a => a.name).join(", ");
    console.log(`\n[init] Selected accounts (${selectedAccounts.length}): ${accountNames}`);
  } else if (sendMode === "internal") {
    // For internal mode, use all accounts with valid addresses
    selectedAccounts = accounts.accounts.filter(acc => String(acc.address || "").trim());
    console.log(`\n[init] Internal mode - using all ${selectedAccounts.length} accounts with addresses (sequential cross-send)`);
  }

  const cycleContext = {
    config,
    accounts: { ...accounts, accounts: selectedAccounts },
    tokens,
    tokensPath,
    sendMode,
    recipientsInfo,
    args,
    legacyCookies
  };

  // Daily loop
  let cycleCount = 0;
  const maxConsecutiveErrors = 3;
  let consecutiveErrors = 0;

  while (true) {
    cycleCount++;

    try {
      // Reload tokens before each cycle (in case manually edited)
      const freshTokens = await readOptionalJson(tokensPath, "tokens");
      const reloadedTokens = normalizeTokens(freshTokens, cycleContext.accounts);
      
      for (const accountEntry of cycleContext.accounts.accounts) {
        const profile = reloadedTokens.accounts[accountEntry.name] || normalizeTokenProfile({});
        if (!String(profile.cookie || "").trim() && cycleContext.legacyCookies.has(accountEntry.name)) {
          profile.cookie = cycleContext.legacyCookies.get(accountEntry.name);
        }
        cycleContext.tokens.accounts[accountEntry.name] = profile;
      }

      // Run the daily cycle
      const cycleResult = await runDailyCycle(cycleContext);
      
      // Reset consecutive errors on success
      consecutiveErrors = 0;

      // Calculate time until next cycle (24 hours from cycle start, or next midnight UTC)
      const now = new Date();
      const nextCycleTime = getNextMidnightUTC();
      const waitMs = Math.max(0, nextCycleTime - now);
      
      if (waitMs > 0 && !args.dryRun) {
        console.log(`\n${"=".repeat(70)}`);
        console.log(`[cycle] Daily cycle #${cycleCount} completed!`);
        console.log(`[cycle] Results: ${cycleResult.successful.length} successful, ${cycleResult.failed.length} failed`);
        console.log(`[cycle] Duration: ${formatDuration(cycleResult.cycleDuration)}`);
        console.log(`[cycle] Next cycle at: ${formatUTCTime(nextCycleTime)}`);
        console.log(`[cycle] Waiting: ${formatDuration(waitMs)}`);
        console.log(`${"=".repeat(70)}\n`);
        
        await sleep(waitMs);
      }

    } catch (error) {
      consecutiveErrors++;
      console.error(`\n[error] Cycle #${cycleCount} failed: ${error.message}`);
      
      if (consecutiveErrors >= maxConsecutiveErrors) {
        console.error(`[fatal] ${maxConsecutiveErrors} consecutive errors. Stopping bot.`);
        throw error;
      }

      // Wait 5 minutes before retrying on error
      const retryDelayMs = 5 * 60 * 1000;
      console.log(`[loop] Retrying in ${formatDuration(retryDelayMs)}... (${consecutiveErrors}/${maxConsecutiveErrors} errors)`);
      await sleep(retryDelayMs);
    }
  }
}

run().catch((error) => {
  console.error(`[error] ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
