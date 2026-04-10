#!/usr/bin/env node
"use strict";

const http = require("http");
const axios = require("axios");

// Load config
let config = {};
try {
  config = require('./config.json');
} catch (err) {
  console.error('Failed to load config.json');
}

const TELEGRAM_BOT_TOKEN = config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = config.telegram?.chatId || process.env.TELEGRAM_CHAT_ID;

// In-memory cache for logs
let cachedLogs = [];
let lastUpdateId = 0;

// Fetch logs from Telegram
async function fetchTelegramLogs() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { success: false, error: 'Telegram not configured' };
  }

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`,
      {
        params: {
          offset: lastUpdateId + 1,
          limit: 100,
          timeout: 30
        }
      }
    );

    if (!response.data.ok) {
      return { success: false, error: 'Telegram API error' };
    }

    const updates = response.data.result;
    const newLogs = [];

    for (const update of updates) {
      if (update.update_id > lastUpdateId) {
        lastUpdateId = update.update_id;
      }

      const message = update.message;
      if (!message || message.chat.id.toString() !== TELEGRAM_CHAT_ID) {
        continue;
      }

      // Parse log from message
      const log = parseLogMessage(message);
      if (log) {
        newLogs.push(log);
      }
    }

    // Add new logs to cache
    cachedLogs = [...newLogs, ...cachedLogs].slice(0, 1000);

    return { success: true, logs: newLogs };
  } catch (error) {
    console.error('[Telegram Fetch Error]', error.message);
    return { success: false, error: error.message };
  }
}

function parseLogMessage(message) {
  const text = message.text || '';
  const timestamp = new Date(message.date * 1000).toISOString();

  // Parse emoji and level
  let level = 'INFO';
  if (text.includes('❌') || text.includes('ERROR')) level = 'ERROR';
  else if (text.includes('⚠️') || text.includes('WARN')) level = 'WARN';
  else if (text.includes('✅') || text.includes('SUCCESS')) level = 'SUCCESS';
  else if (text.includes('ℹ️') || text.includes('INFO')) level = 'INFO';

  // Extract account tag
  const accountMatch = text.match(/\[(A\d+\/\d+)\]/);
  const accountTag = accountMatch ? accountMatch[1] : null;

  // Clean message
  let cleanMessage = text
    .replace(/[ℹ️⚠️❌✅📝🕐👥📊📈🚀🛑]/g, '')
    .replace(/<\/?b>/g, '')
    .replace(/INFO|WARN|ERROR|SUCCESS/gi, '')
    .replace(/\[A\d+\/\d+\]/g, '')
    .trim();

  // Remove timestamp line
  const lines = cleanMessage.split('\n').filter(line => {
    return !line.match(/^\d{1,2}\/\d{1,2}\/\d{4}/) && line.trim();
  });
  cleanMessage = lines.join(' ').trim();

  return {
    message_id: message.message_id,
    timestamp,
    level,
    accountTag,
    message: cleanMessage,
    raw: text
  };
}

// SSE clients
const sseClients = new Set();

function broadcastLog(log) {
  const data = JSON.stringify({ type: 'log', data: log });
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  });
}

// Polling Telegram for new messages
let isPolling = false;
async function startPolling() {
  if (isPolling) return;
  isPolling = true;

  console.log('[Telegram Monitor] Starting polling...');

  while (isPolling) {
    const result = await fetchTelegramLogs();
    
    if (result.success && result.logs.length > 0) {
      result.logs.forEach(log => broadcastLog(log));
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Serve HTML UI
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getHtmlUI());
    return;
  }
  
  // API: Get all logs
  if (req.url === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true,
      logs: cachedLogs,
      configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    }));
    return;
  }
  
  // API: Refresh logs from Telegram
  if (req.url === '/api/refresh' && req.method === 'POST') {
    fetchTelegramLogs().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  
  // API: SSE stream for real-time logs
  if (req.url === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    
    sseClients.add(res);
    
    // Send initial data
    res.write(`data: ${JSON.stringify({ 
      type: 'init', 
      logs: cachedLogs.slice(0, 50),
      configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    })}\n\n`);
    
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }
  
  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

function getHtmlUI() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RootsFi Bot Monitor - Telegram</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      min-height: 100vh;
      padding: 20px;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .header {
      background: white;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    
    .header h1 {
      color: #667eea;
      font-size: 28px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .telegram-badge {
      background: linear-gradient(135deg, #0088cc, #00a0e9);
      color: white;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: normal;
    }
    
    .header .subtitle {
      color: #666;
      font-size: 14px;
      margin-top: 8px;
    }
    
    .status-indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
      animation: pulse 2s infinite;
    }
    
    .status-indicator.connected { background: #10b981; }
    .status-indicator.disconnected { background: #ef4444; }
    .status-indicator.warning { background: #f59e0b; }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    
    .stat-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    
    .stat-card .label {
      color: #666;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    
    .stat-card .value {
      font-size: 32px;
      font-weight: bold;
      color: #333;
    }
    
    .stat-card.success .value { color: #10b981; }
    .stat-card.error .value { color: #ef4444; }
    .stat-card.warn .value { color: #f59e0b; }
    .stat-card.info .value { color: #3b82f6; }
    
    .log-container {
      background: white;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      max-height: calc(100vh - 400px);
      overflow-y: auto;
    }
    
    .log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 2px solid #f3f4f6;
      flex-wrap: wrap;
      gap: 12px;
    }
    
    .log-header h2 {
      color: #333;
      font-size: 20px;
    }
    
    .controls {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    
    .filter-buttons {
      display: flex;
      gap: 8px;
    }
    
    .filter-btn, .refresh-btn, .clear-btn {
      padding: 6px 12px;
      border: 1px solid #e5e7eb;
      background: white;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }
    
    .filter-btn:hover, .refresh-btn:hover {
      background: #f9fafb;
    }
    
    .filter-btn.active {
      background: #667eea;
      color: white;
      border-color: #667eea;
    }
    
    .refresh-btn {
      background: #10b981;
      color: white;
      border-color: #10b981;
    }
    
    .refresh-btn:hover {
      background: #059669;
    }
    
    .clear-btn {
      background: #ef4444;
      color: white;
      border-color: #ef4444;
    }
    
    .clear-btn:hover {
      background: #dc2626;
    }
    
    .log-entry {
      padding: 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      border-left: 4px solid #e5e7eb;
      background: #f9fafb;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      line-height: 1.6;
      animation: slideIn 0.3s ease-out;
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .log-entry.INFO { border-left-color: #3b82f6; }
    .log-entry.WARN { border-left-color: #f59e0b; background: #fffbeb; }
    .log-entry.ERROR { border-left-color: #ef4444; background: #fef2f2; }
    .log-entry.SUCCESS { border-left-color: #10b981; background: #f0fdf4; }
    
    .log-entry .timestamp {
      color: #6b7280;
      font-size: 11px;
      margin-right: 8px;
    }
    
    .log-entry .level {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      margin-right: 8px;
    }
    
    .log-entry .level.INFO { background: #dbeafe; color: #1e40af; }
    .log-entry .level.WARN { background: #fef3c7; color: #92400e; }
    .log-entry .level.ERROR { background: #fee2e2; color: #991b1b; }
    .log-entry .level.SUCCESS { background: #d1fae5; color: #065f46; }
    
    .log-entry .account-tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      background: #e0e7ff;
      color: #4338ca;
      margin-right: 8px;
    }
    
    .log-entry .message {
      color: #1f2937;
      word-break: break-word;
    }
    
    .no-logs {
      text-align: center;
      padding: 40px;
      color: #9ca3af;
    }
    
    .alert {
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .alert.warning {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fbbf24;
    }
    
    .alert.error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #f87171;
    }
    
    ::-webkit-scrollbar {
      width: 8px;
    }
    
    ::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 4px;
    }
    
    ::-webkit-scrollbar-thumb {
      background: #888;
      border-radius: 4px;
    }
    
    ::-webkit-scrollbar-thumb:hover {
      background: #555;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        🤖 RootsFi Bot Monitor
        <span class="telegram-badge">📱 Telegram</span>
      </h1>
      <p class="subtitle">
        <span class="status-indicator" id="statusIndicator"></span>
        <span id="statusText">Connecting...</span> | 
        Last Update: <span id="lastUpdate">-</span>
      </p>
    </div>
    
    <div id="alertContainer"></div>
    
    <div class="stats-grid">
      <div class="stat-card info">
        <div class="label">Total Logs</div>
        <div class="value" id="statTotal">0</div>
      </div>
      <div class="stat-card success">
        <div class="label">Success</div>
        <div class="value" id="statSuccess">0</div>
      </div>
      <div class="stat-card error">
        <div class="label">Errors</div>
        <div class="value" id="statError">0</div>
      </div>
      <div class="stat-card warn">
        <div class="label">Warnings</div>
        <div class="value" id="statWarn">0</div>
      </div>
    </div>
    
    <div class="log-container">
      <div class="log-header">
        <h2>📋 Telegram Logs</h2>
        <div class="controls">
          <div class="filter-buttons">
            <button class="filter-btn active" data-filter="ALL">ALL</button>
            <button class="filter-btn" data-filter="INFO">INFO</button>
            <button class="filter-btn" data-filter="SUCCESS">SUCCESS</button>
            <button class="filter-btn" data-filter="WARN">WARN</button>
            <button class="filter-btn" data-filter="ERROR">ERROR</button>
          </div>
          <button class="refresh-btn" onclick="refreshLogs()">🔄 Refresh</button>
          <button class="clear-btn" onclick="clearLogs()">🗑️ Clear</button>
        </div>
      </div>
      <div id="logList">
        <div class="no-logs">Connecting to Telegram...</div>
      </div>
    </div>
  </div>
  
  <script>
    let currentFilter = 'ALL';
    let allLogs = [];
    let isConfigured = false;
    
    // Connect to SSE stream
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'init') {
        allLogs = data.logs;
        isConfigured = data.configured;
        updateStatus();
        renderLogs();
      } else if (data.type === 'log') {
        allLogs.unshift(data.data);
        if (allLogs.length > 500) allLogs.pop();
        updateStatus();
        renderLogs();
      }
    };
    
    eventSource.onerror = () => {
      document.getElementById('statusText').textContent = 'Disconnected';
      document.getElementById('statusIndicator').className = 'status-indicator disconnected';
    };
    
    function updateStatus() {
      const alertContainer = document.getElementById('alertContainer');
      
      if (!isConfigured) {
        document.getElementById('statusText').textContent = 'Not Configured';
        document.getElementById('statusIndicator').className = 'status-indicator warning';
        alertContainer.innerHTML = \`
          <div class="alert warning">
            <span>⚠️</span>
            <div>
              <strong>Telegram Not Configured</strong><br>
              Please add telegram configuration to config.json
            </div>
          </div>
        \`;
      } else {
        document.getElementById('statusText').textContent = 'Connected';
        document.getElementById('statusIndicator').className = 'status-indicator connected';
        alertContainer.innerHTML = '';
      }
      
      document.getElementById('lastUpdate').textContent = new Date().toLocaleString('id-ID');
      
      const stats = {
        total: allLogs.length,
        success: allLogs.filter(l => l.level === 'SUCCESS').length,
        error: allLogs.filter(l => l.level === 'ERROR').length,
        warn: allLogs.filter(l => l.level === 'WARN').length
      };
      
      document.getElementById('statTotal').textContent = stats.total;
      document.getElementById('statSuccess').textContent = stats.success;
      document.getElementById('statError').textContent = stats.error;
      document.getElementById('statWarn').textContent = stats.warn;
    }
    
    function renderLogs() {
      const logList = document.getElementById('logList');
      const filteredLogs = currentFilter === 'ALL' 
        ? allLogs 
        : allLogs.filter(log => log.level === currentFilter);
      
      if (filteredLogs.length === 0) {
        logList.innerHTML = '<div class="no-logs">No logs to display</div>';
        return;
      }
      
      logList.innerHTML = filteredLogs.map(log => {
        const time = new Date(log.timestamp).toLocaleTimeString('id-ID');
        const accountTag = log.accountTag ? \`<span class="account-tag">\${log.accountTag}</span>\` : '';
        return \`
          <div class="log-entry \${log.level}">
            <span class="timestamp">\${time}</span>
            <span class="level \${log.level}">\${log.level}</span>
            \${accountTag}
            <span class="message">\${escapeHtml(log.message)}</span>
          </div>
        \`;
      }).join('');
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    async function refreshLogs() {
      try {
        const response = await fetch('/api/refresh', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
          // Logs will be updated via SSE
          console.log('Refreshed from Telegram');
        }
      } catch (error) {
        console.error('Refresh failed:', error);
      }
    }
    
    function clearLogs() {
      if (confirm('Clear all logs from display?')) {
        allLogs = [];
        renderLogs();
        updateStatus();
      }
    }
    
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderLogs();
      });
    });
    
    // Auto-refresh every 30 seconds
    setInterval(() => {
      if (isConfigured) {
        refreshLogs();
      }
    }, 30000);
  </script>
</body>
</html>`;
}

const PORT = process.env.MONITOR_PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n🚀 RootsFi Bot Monitor (Telegram) running at http://localhost:${PORT}`);
  console.log(`📱 Monitoring Telegram chat: ${TELEGRAM_CHAT_ID || 'NOT CONFIGURED'}\n`);
  
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    startPolling();
  } else {
    console.log('⚠️  Telegram not configured. Please add to config.json:');
    console.log('   "telegram": {');
    console.log('     "enabled": true,');
    console.log('     "botToken": "YOUR_BOT_TOKEN",');
    console.log('     "chatId": "YOUR_CHAT_ID"');
    console.log('   }\n');
  }
});

module.exports = { server };
