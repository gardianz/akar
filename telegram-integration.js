#!/usr/bin/env node
"use strict";

// Tambahkan di bagian paling atas index.js, setelah require statements
const TelegramLogger = require('./telegram-logger.js');
const fs = require('fs');
const path = require('path');

// Load config
let config = {};
try {
  const configPath = path.join(__dirname, 'config.json');
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('Failed to load config.json:', err.message);
}

// Initialize Telegram Logger
const telegramLogger = new TelegramLogger(config.telegram || {});

// Store original console methods
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error
};

// Helper to extract important info from log message
function parseLogInfo(message) {
  const info = {
    isImportant: false,
    level: 'INFO',
    accountTag: null,
    cleanMessage: message
  };

  // Extract account tag [A1/9] or [account 1/9]
  const accountMatch = message.match(/\[A?(\d+)\/(\d+)\]/) || message.match(/\[account\s+(\d+)\/(\d+)\]/i);
  if (accountMatch) {
    info.accountTag = `A${accountMatch[1]}/${accountMatch[2]}`;
  }

  // Determine if important
  const importantKeywords = [
    'Processing:',
    'Balance:',
    'Send tx',
    'Transfer',
    'completed',
    'success',
    'failed',
    'error',
    'cooldown',
    'This Week Reward',
    'Round'
  ];

  const lowerMsg = message.toLowerCase();
  info.isImportant = importantKeywords.some(keyword => 
    lowerMsg.includes(keyword.toLowerCase())
  );

  // Determine level
  if (lowerMsg.includes('error') || lowerMsg.includes('failed')) {
    info.level = 'ERROR';
  } else if (lowerMsg.includes('warn') || lowerMsg.includes('warning')) {
    info.level = 'WARN';
  } else if (lowerMsg.includes('success') || lowerMsg.includes('completed') || lowerMsg.includes('ok')) {
    info.level = 'SUCCESS';
  }

  // Clean message - remove tags and extra info
  info.cleanMessage = message
    .replace(/\[A?\d+\/\d+\]\s*/g, '')
    .replace(/\[account\s+\d+\/\d+\]\s*/gi, '')
    .replace(/\[[\w-]+\]\s*/g, '') // Remove [step], [info], etc
    .replace(/\s+/g, ' ')
    .trim();

  return info;
}

// Override console.log to send important logs to Telegram
console.log = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const info = parseLogInfo(message);

  // Send to Telegram only if important
  if (info.isImportant && telegramLogger.enabled) {
    telegramLogger.log(info.level, info.cleanMessage, info.accountTag).catch(err => {
      // Silent fail - don't break bot if Telegram fails
    });
  }

  // Always log to console
  originalConsole.log(...args);
};

console.warn = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const info = parseLogInfo(message);

  if (telegramLogger.enabled) {
    telegramLogger.warn(info.cleanMessage, info.accountTag).catch(err => {});
  }

  originalConsole.warn(...args);
};

console.error = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const info = parseLogInfo(message);

  if (telegramLogger.enabled) {
    telegramLogger.error(info.cleanMessage, info.accountTag).catch(err => {});
  }

  originalConsole.error(...args);
};

// Send bot start notification
(async () => {
  try {
    const accountsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf8'));
    const accountCount = accountsData.accounts?.length || 0;
    await telegramLogger.sendStartNotification(accountCount);
  } catch (err) {
    // Silent fail
  }
})();

// Send bot stop notification on exit
process.on('SIGINT', async () => {
  try {
    await telegramLogger.sendStopNotification({
      total: globalSwapsTotal || 0,
      success: globalSwapsOk || 0,
      failed: globalSwapsFail || 0
    });
  } catch (err) {
    // Silent fail
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  try {
    await telegramLogger.sendStopNotification({
      total: globalSwapsTotal || 0,
      success: globalSwapsOk || 0,
      failed: globalSwapsFail || 0
    });
  } catch (err) {
    // Silent fail
  }
  process.exit(0);
});

// Export for use in other parts of the code
module.exports = {
  telegramLogger,
  sendTelegramLog: (level, message, accountTag) => {
    if (telegramLogger.enabled) {
      return telegramLogger.log(level, message, accountTag);
    }
    return Promise.resolve();
  }
};

console.log('[Telegram] Logger integration loaded');
