#!/usr/bin/env node
"use strict";

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');

class TelegramLogger {
  constructor(config) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.enabled = config.enabled !== false;
    this.bot = null;
    this.messageQueue = [];
    this.isProcessing = false;
    this.rateLimitDelay = 1000; // 1 second between messages to avoid rate limit
    
    if (this.enabled && this.botToken && this.chatId) {
      this.bot = new TelegramBot(this.botToken, { polling: false });
      console.log('[Telegram] Logger initialized');
    } else {
      console.log('[Telegram] Logger disabled or not configured');
    }
  }

  async sendMessage(text, options = {}) {
    if (!this.enabled || !this.bot) {
      return null;
    }

    try {
      const message = await this.bot.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      });
      return message;
    } catch (error) {
      console.error('[Telegram] Send error:', error.message);
      return null;
    }
  }

  async queueMessage(text, options = {}) {
    this.messageQueue.push({ text, options });
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.messageQueue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const { text, options } = this.messageQueue.shift();
    
    await this.sendMessage(text, options);
    await this.sleep(this.rateLimitDelay);
    
    this.processQueue();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  formatLog(level, message, accountTag = null) {
    const timestamp = new Date().toLocaleString('id-ID', { 
      timeZone: 'Asia/Jakarta',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    const emoji = {
      'INFO': 'ℹ️',
      'WARN': '⚠️',
      'ERROR': '❌',
      'SUCCESS': '✅'
    }[level.toUpperCase()] || '📝';

    // Clean message - remove extra whitespace and newlines
    const cleanMsg = String(message)
      .replace(/\s+/g, ' ')
      .trim();

    const accountInfo = accountTag ? `<code>[${accountTag}]</code> ` : '';
    
    // Format: Single line, compact
    return `${emoji} <b>${level.toUpperCase()}</b> | ${timestamp}\n${accountInfo}${this.escapeHtml(cleanMsg)}`;
  }

  escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async log(level, message, accountTag = null) {
    const formatted = this.formatLog(level, message, accountTag);
    await this.queueMessage(formatted);
  }

  async info(message, accountTag = null) {
    await this.log('INFO', message, accountTag);
  }

  async warn(message, accountTag = null) {
    await this.log('WARN', message, accountTag);
  }

  async error(message, accountTag = null) {
    await this.log('ERROR', message, accountTag);
  }

  async success(message, accountTag = null) {
    await this.log('SUCCESS', message, accountTag);
  }

  async sendStats(stats) {
    const text = `📊 <b>Bot Statistics</b>\n\n` +
                 `✅ Success: ${stats.success}\n` +
                 `❌ Failed: ${stats.failed}\n` +
                 `📈 Total: ${stats.total}\n` +
                 `👥 Accounts: ${stats.accounts || 0}`;
    
    await this.queueMessage(text);
  }

  async sendStartNotification(accountCount) {
    const text = `🚀 <b>RootsFi Bot Started</b>\n\n` +
                 `👥 Accounts: ${accountCount}\n` +
                 `🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
    
    await this.sendMessage(text);
  }

  async sendStopNotification(stats) {
    const text = `🛑 <b>RootsFi Bot Stopped</b>\n\n` +
                 `📊 Final Stats:\n` +
                 `✅ Success: ${stats.success}\n` +
                 `❌ Failed: ${stats.failed}\n` +
                 `📈 Total: ${stats.total}\n` +
                 `🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
    
    await this.sendMessage(text);
  }

  async getRecentMessages(limit = 100) {
    if (!this.enabled || !this.bot) {
      return [];
    }

    try {
      const updates = await this.bot.getUpdates({ limit });
      return updates
        .filter(update => update.message && update.message.chat.id.toString() === this.chatId)
        .map(update => ({
          message_id: update.message.message_id,
          text: update.message.text,
          date: update.message.date,
          timestamp: new Date(update.message.date * 1000).toISOString()
        }));
    } catch (error) {
      console.error('[Telegram] Get messages error:', error.message);
      return [];
    }
  }
}

module.exports = TelegramLogger;
