#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// In-memory log storage
const logs = [];
const MAX_LOGS = 1000;

// Store bot status
let botStatus = {
  isRunning: false,
  accounts: [],
  stats: {
    total: 0,
    success: 0,
    failed: 0
  },
  lastUpdate: new Date().toISOString()
};

// Add log entry
function addLog(level, message, accountTag = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message: message,
    accountTag: accountTag
  };
  
  logs.unshift(logEntry);
  
  if (logs.length > MAX_LOGS) {
    logs.pop();
  }
  
  // Broadcast to all connected SSE clients
  broadcastLog(logEntry);
}

// SSE clients
const sseClients = new Set();

function broadcastLog(logEntry) {
  const data = JSON.stringify(logEntry);
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  });
}

function broadcastStatus() {
  const data = JSON.stringify({ type: 'status', data: botStatus });
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  });
}

// Override console methods to capture logs
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error
};

console.log = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const accountMatch = message.match(/^\[(A\d+\/\d+)\]\s*/i);
  const accountTag = accountMatch ? accountMatch[1] : null;
  const cleanMessage = accountMatch ? message.slice(accountMatch[0].length) : message;
  
  addLog('INFO', cleanMessage, accountTag);
  originalConsole.log(...args);
};

console.warn = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  addLog('WARN', message);
  originalConsole.warn(...args);
};

console.error = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  addLog('ERROR', message);
  originalConsole.error(...args);
};

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
    res.end(JSON.stringify({ logs, status: botStatus }));
    return;
  }
  
  // API: Get bot status
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botStatus));
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
    res.write(`data: ${JSON.stringify({ type: 'init', logs: logs.slice(0, 50), status: botStatus })}\n\n`);
    
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }
  
  // API: Update bot status
  if (req.url === '/api/status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        botStatus = { ...botStatus, ...update, lastUpdate: new Date().toISOString() };
        broadcastStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
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
  <title>RootsFi Bot Monitor</title>
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
    }
    
    .header .subtitle {
      color: #666;
      font-size: 14px;
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
    .stat-card.failed .value { color: #ef4444; }
    .stat-card.total .value { color: #667eea; }
    
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
    }
    
    .log-header h2 {
      color: #333;
      font-size: 20px;
    }
    
    .filter-buttons {
      display: flex;
      gap: 8px;
    }
    
    .filter-btn {
      padding: 6px 12px;
      border: 1px solid #e5e7eb;
      background: white;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }
    
    .filter-btn:hover {
      background: #f9fafb;
    }
    
    .filter-btn.active {
      background: #667eea;
      color: white;
      border-color: #667eea;
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
    
    .status-indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
      animation: pulse 2s infinite;
    }
    
    .status-indicator.running { background: #10b981; }
    .status-indicator.stopped { background: #ef4444; }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .no-logs {
      text-align: center;
      padding: 40px;
      color: #9ca3af;
    }
    
    .clear-btn {
      padding: 8px 16px;
      background: #ef4444;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    
    .clear-btn:hover {
      background: #dc2626;
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
      <h1>🤖 RootsFi Bot Monitor</h1>
      <p class="subtitle">
        <span class="status-indicator" id="statusIndicator"></span>
        <span id="statusText">Connecting...</span> | 
        Last Update: <span id="lastUpdate">-</span>
      </p>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card total">
        <div class="label">Total Transaksi</div>
        <div class="value" id="statTotal">0</div>
      </div>
      <div class="stat-card success">
        <div class="label">Berhasil</div>
        <div class="value" id="statSuccess">0</div>
      </div>
      <div class="stat-card failed">
        <div class="label">Gagal</div>
        <div class="value" id="statFailed">0</div>
      </div>
      <div class="stat-card">
        <div class="label">Akun Aktif</div>
        <div class="value" id="statAccounts">0</div>
      </div>
    </div>
    
    <div class="log-container">
      <div class="log-header">
        <h2>📋 Execution Logs</h2>
        <div style="display: flex; gap: 8px;">
          <div class="filter-buttons">
            <button class="filter-btn active" data-filter="ALL">ALL</button>
            <button class="filter-btn" data-filter="INFO">INFO</button>
            <button class="filter-btn" data-filter="WARN">WARN</button>
            <button class="filter-btn" data-filter="ERROR">ERROR</button>
          </div>
          <button class="clear-btn" onclick="clearLogs()">Clear</button>
        </div>
      </div>
      <div id="logList">
        <div class="no-logs">Waiting for logs...</div>
      </div>
    </div>
  </div>
  
  <script>
    let currentFilter = 'ALL';
    let allLogs = [];
    
    // Connect to SSE stream
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'init') {
        allLogs = data.logs;
        updateStatus(data.status);
        renderLogs();
      } else if (data.type === 'status') {
        updateStatus(data.data);
      } else {
        // New log entry
        allLogs.unshift(data);
        if (allLogs.length > 500) allLogs.pop();
        renderLogs();
      }
    };
    
    eventSource.onerror = () => {
      document.getElementById('statusText').textContent = 'Disconnected';
      document.getElementById('statusIndicator').className = 'status-indicator stopped';
    };
    
    function updateStatus(status) {
      document.getElementById('statusText').textContent = status.isRunning ? 'Running' : 'Stopped';
      document.getElementById('statusIndicator').className = 'status-indicator ' + (status.isRunning ? 'running' : 'stopped');
      document.getElementById('lastUpdate').textContent = new Date(status.lastUpdate).toLocaleString('id-ID');
      
      document.getElementById('statTotal').textContent = status.stats.total;
      document.getElementById('statSuccess').textContent = status.stats.success;
      document.getElementById('statFailed').textContent = status.stats.failed;
      document.getElementById('statAccounts').textContent = status.accounts.length;
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
    
    function clearLogs() {
      if (confirm('Clear all logs?')) {
        allLogs = [];
        renderLogs();
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
    
    // Auto-scroll to top when new log arrives
    let lastLogCount = 0;
    setInterval(() => {
      if (allLogs.length > lastLogCount) {
        lastLogCount = allLogs.length;
      }
    }, 1000);
  </script>
</body>
</html>`;
}

const PORT = process.env.MONITOR_PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n🚀 RootsFi Bot Monitor Server running at http://localhost:${PORT}`);
  console.log(`📊 Open your browser to view the monitoring dashboard\n`);
});

// Export functions for use in main bot
module.exports = {
  addLog,
  updateStatus: (status) => {
    botStatus = { ...botStatus, ...status, lastUpdate: new Date().toISOString() };
    broadcastStatus();
  },
  server
};
