// Contoh integrasi Telegram Logger ke index.js
// Tambahkan code ini di bagian awal index.js (setelah require statements)

const TelegramLogger = require('./telegram-logger.js');
const config = require('./config.json');

// Inisialisasi Telegram Logger
const telegramLogger = new TelegramLogger(config.telegram || {});

// Override console.log untuk mengirim ke Telegram
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const accountMatch = message.match(/^\[(A\d+\/\d+)\]\s*/i);
  const accountTag = accountMatch ? accountMatch[1] : null;
  const cleanMessage = accountMatch ? message.slice(accountMatch[0].length) : message;
  
  // Tentukan level berdasarkan message
  let level = 'INFO';
  if (message.toLowerCase().includes('success') || message.toLowerCase().includes(' ok ')) {
    level = 'SUCCESS';
  }
  
  telegramLogger.log(level, cleanMessage, accountTag);
  originalConsoleLog(...args);
};

console.warn = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const accountMatch = message.match(/^\[(A\d+\/\d+)\]\s*/i);
  const accountTag = accountMatch ? accountMatch[1] : null;
  const cleanMessage = accountMatch ? message.slice(accountMatch[0].length) : message;
  
  telegramLogger.warn(cleanMessage, accountTag);
  originalConsoleWarn(...args);
};

console.error = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const accountMatch = message.match(/^\[(A\d+\/\d+)\]\s*/i);
  const accountTag = accountMatch ? accountMatch[1] : null;
  const cleanMessage = accountMatch ? message.slice(accountMatch[0].length) : message;
  
  telegramLogger.error(cleanMessage, accountTag);
  originalConsoleError(...args);
};

// Kirim notifikasi saat bot start
(async () => {
  const accountCount = config.accounts?.length || 0;
  await telegramLogger.sendStartNotification(accountCount);
})();

// Kirim notifikasi saat bot stop
process.on('SIGINT', async () => {
  await telegramLogger.sendStopNotification({
    total: globalSwapsTotal || 0,
    success: globalSwapsOk || 0,
    failed: globalSwapsFail || 0
  });
  process.exit(0);
});

// Export untuk digunakan di bagian lain code
module.exports.telegramLogger = telegramLogger;
