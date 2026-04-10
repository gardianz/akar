#!/usr/bin/env node
"use strict";

// ============================================================================
// RootsFi Bot - Unified with Check-in Integration
// ============================================================================

const fs = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { setTimeout: sleep } = require("node:timers/promises");

// Telegram Logger Integration
let TelegramLogger;
let telegramLogger = null;
try {
  TelegramLogger = require('./telegram-logger.js');
} catch (err) {
  console.log('[Telegram] Logger module not found');
}

// Load original index.js content
const originalIndexPath = path.join(__dirname, 'index.js');

// Check-in function
async function runDailyCheckin(accounts, tokens, tokensPath) {
  if (!telegramLogger) {
    console.log('[Check-in] Telegram logger not available, skipping check-in notification');
    return;
  }

  console.log('\n[Check-in] Starting daily check-in for all accounts...');
  
  const results = {};
  const checkinResults = [];

  for (let i = 0; i < accounts.accounts.length; i++) {
    const acc = accounts.accounts[i];
    const profile = tokens.accounts[acc.name];
    
    try {
      // Simulate check-in (you'll need to implement actual check-in logic)
      console.log(`[Check-in] Processing ${acc.name}...`);
      
      // For now, just mark as success
      results[acc.name] = {
        ok: true,
        reason: 'ok',
        streak: 1,
        points: 1,
        tier: 'Newbie'
      };
      
      checkinResults.push({
        name: acc.name,
        status: 'OK',
        streak: '1d',
        points: '1',
        tier: 'Newbie'
      });
      
    } catch (err) {
      console.log(`[Check-in] Failed for ${acc.name}: ${err.message}`);
      results[acc.name] = {
        ok: false,
        reason: err.message
      };
    }
  }

  // Send check-in dashboard to Telegram
  await sendCheckinDashboard(accounts.accounts, results);
  
  console.log('[Check-in] Daily check-in completed');
}

async function sendCheckinDashboard(accounts, results) {
  if (!telegramLogger) return;

  try {
    const now = new Date().toLocaleString("id-ID", { 
      timeZone: "Asia/Jakarta",
      hour12: false 
    }) + " WIB";

    let message = `<b>🎯 RootsFi Daily Check-In</b>\n`;
    message += `📅 ${now}\n`;
    message += `👥 ${accounts.length} accounts\n\n`;
    message += `<pre>`;
    message += `Account         Status  Streak Points Tier\n`;
    message += `${"─".repeat(50)}\n`;

    let okCount = 0;
    let failCount = 0;

    for (const acc of accounts) {
      const r = results[acc.name];
      let status = "PENDING";
      let streak = "-";
      let points = "-";
      let tier = "-";

      if (r) {
        if (r.ok) {
          okCount++;
          status = r.reason === "already-checked-in" ? "DONE" : "OK";
          streak = String(r.streak || 0) + "d";
          points = String(r.points || 0);
          tier = r.tier || "-";
        } else {
          failCount++;
          status = "FAIL";
        }
      }

      const name = pad(acc.name, 15);
      const statusPad = pad(status, 7);
      const streakPad = pad(streak, 6);
      const pointsPad = pad(points, 6);
      const tierPad = tier;

      message += `${name} ${statusPad} ${streakPad} ${pointsPad} ${tierPad}\n`;
    }

    message += `</pre>\n`;
    message += `\n✅ Success: ${okCount} | ❌ Failed: ${failCount}`;

    await telegramLogger.sendMessage(message, { parse_mode: 'HTML' });
    console.log('[Telegram] Check-in dashboard sent');
  } catch (err) {
    console.log('[Telegram] Failed to send check-in dashboard:', err.message);
  }
}

function pad(str, len) {
  const s = String(str || "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

// Export for use in index.js
module.exports = {
  runDailyCheckin,
  sendCheckinDashboard,
  initTelegramLogger: (config) => {
    if (TelegramLogger && config.telegram && config.telegram.enabled) {
      try {
        telegramLogger = new TelegramLogger(config.telegram);
        console.log('[Telegram] Logger initialized');
        return telegramLogger;
      } catch (err) {
        console.log('[Telegram] Failed to initialize:', err.message);
        return null;
      }
    }
    return null;
  }
};
