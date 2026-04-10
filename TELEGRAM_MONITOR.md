# 📱 RootsFi Bot - Telegram Monitor UI

UI monitoring untuk memantau log bot RootsFi yang dikirim ke Telegram secara real-time.

## 🎯 Fitur Utama

✅ **Monitoring Real-time** - Log dari Telegram muncul otomatis di UI web
✅ **Telegram Integration** - Bot mengirim log ke Telegram, UI membaca dari Telegram
✅ **Color-coded Logs** - INFO (biru), SUCCESS (hijau), WARN (kuning), ERROR (merah)
✅ **Filter Logs** - Filter berdasarkan level (ALL/INFO/SUCCESS/WARN/ERROR)
✅ **Statistics** - Lihat total log, success, error, dan warning
✅ **Auto-refresh** - Polling otomatis setiap 30 detik
✅ **Responsive Design** - Tampilan modern dengan gradient background

---

## 🚀 Setup & Instalasi

### 1. Buat Telegram Bot

1. Buka Telegram dan cari **@BotFather**
2. Kirim command `/newbot`
3. Ikuti instruksi untuk membuat bot baru
4. Simpan **Bot Token** yang diberikan (contoh: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Dapatkan Chat ID

**Cara 1: Menggunakan Bot**
1. Cari bot Anda di Telegram
2. Kirim pesan `/start` ke bot
3. Buka browser dan akses:
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
   ```
   Ganti `<BOT_TOKEN>` dengan token bot Anda
4. Cari `"chat":{"id":` di response, angka setelahnya adalah Chat ID Anda

**Cara 2: Menggunakan @userinfobot**
1. Cari **@userinfobot** di Telegram
2. Kirim pesan apa saja
3. Bot akan membalas dengan Chat ID Anda

### 3. Konfigurasi Bot

Edit file `config.json` dan tambahkan konfigurasi Telegram:

\`\`\`json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "chatId": "987654321"
  }
}
\`\`\`

Ganti:
- `botToken` dengan Bot Token dari BotFather
- `chatId` dengan Chat ID Anda

### 4. Install Dependencies

\`\`\`bash
npm install
\`\`\`

---

## 📖 Cara Menggunakan

### Opsi 1: Monitoring Saja (Tanpa Bot)

Jika bot sudah berjalan dan mengirim log ke Telegram, Anda bisa jalankan monitor untuk melihat log:

\`\`\`bash
npm run monitor
\`\`\`

Lalu buka browser: **http://localhost:3000**

### Opsi 2: Bot + Monitoring Terintegrasi

Tambahkan Telegram logger ke bot utama Anda. Edit file `index.js`, tambahkan di bagian awal:

\`\`\`javascript
// Di bagian paling atas setelah require statements
const TelegramLogger = require('./telegram-logger.js');
const config = require('./config.json');

// Inisialisasi Telegram Logger
const telegramLogger = new TelegramLogger(config.telegram || {});

// Override console.log untuk mengirim ke Telegram
const originalConsoleLog = console.log;
console.log = (...args) => {
  const message = args.map(a => String(a)).join(' ');
  const accountMatch = message.match(/^\[(A\d+\/\d+)\]\s*/i);
  const accountTag = accountMatch ? accountMatch[1] : null;
  const cleanMessage = accountMatch ? message.slice(accountMatch[0].length) : message;
  
  // Tentukan level berdasarkan message
  let level = 'INFO';
  if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
    level = 'ERROR';
  } else if (message.toLowerCase().includes('warn')) {
    level = 'WARN';
  } else if (message.toLowerCase().includes('success') || message.toLowerCase().includes('ok')) {
    level = 'SUCCESS';
  }
  
  telegramLogger.log(level, cleanMessage, accountTag);
  originalConsoleLog(...args);
};
\`\`\`

Kemudian jalankan bot:

\`\`\`bash
npm start
\`\`\`

Di terminal lain, jalankan monitor:

\`\`\`bash
npm run monitor
\`\`\`

---

## 🎨 Tampilan UI

Dashboard menampilkan:

### Header
- Status koneksi (Connected/Disconnected/Not Configured)
- Badge Telegram
- Waktu update terakhir

### Statistics Cards
- **Total Logs** - Jumlah semua log
- **Success** - Jumlah log sukses (hijau)
- **Errors** - Jumlah error (merah)
- **Warnings** - Jumlah warning (kuning)

### Log Container
- Filter buttons (ALL/INFO/SUCCESS/WARN/ERROR)
- Refresh button - Manual refresh dari Telegram
- Clear button - Hapus log dari tampilan
- Log entries dengan:
  - Timestamp
  - Level badge (color-coded)
  - Account tag (jika ada)
  - Message

---

## ⚙️ Konfigurasi Lanjutan

### Custom Port

Jika port 3000 sudah digunakan:

**Windows (Command Prompt):**
\`\`\`cmd
set MONITOR_PORT=8080 && npm run monitor
\`\`\`

**Windows (PowerShell):**
\`\`\`powershell
$env:MONITOR_PORT=8080; npm run monitor
\`\`\`

**Linux/Mac:**
\`\`\`bash
MONITOR_PORT=8080 npm run monitor
\`\`\`

### Disable Telegram Logger

Jika ingin menonaktifkan sementara tanpa menghapus konfigurasi:

\`\`\`json
{
  "telegram": {
    "enabled": false,
    "botToken": "...",
    "chatId": "..."
  }
}
\`\`\`

---

## 📡 API Endpoints

Monitor server menyediakan API:

- **GET /** - UI Dashboard
- **GET /api/logs** - Ambil semua log (JSON)
- **POST /api/refresh** - Manual refresh dari Telegram
- **GET /api/stream** - SSE stream untuk real-time updates

### Contoh API Usage

\`\`\`javascript
// Fetch logs
fetch('http://localhost:3000/api/logs')
  .then(res => res.json())
  .then(data => console.log(data.logs));

// Manual refresh
fetch('http://localhost:3000/api/refresh', { method: 'POST' })
  .then(res => res.json())
  .then(data => console.log('Refreshed:', data.success));
\`\`\`

---

## 🔧 Penggunaan Telegram Logger di Code

### Basic Usage

\`\`\`javascript
const TelegramLogger = require('./telegram-logger.js');
const logger = new TelegramLogger({
  enabled: true,
  botToken: 'YOUR_BOT_TOKEN',
  chatId: 'YOUR_CHAT_ID'
});

// Send logs
await logger.info('Bot started successfully');
await logger.warn('Low balance detected', 'A1/10');
await logger.error('Transaction failed', 'A2/10');
await logger.success('Transaction completed', 'A1/10');

// Send statistics
await logger.sendStats({
  total: 100,
  success: 95,
  failed: 5,
  accounts: 10
});

// Send notifications
await logger.sendStartNotification(10); // 10 accounts
await logger.sendStopNotification({ total: 100, success: 95, failed: 5 });
\`\`\`

### Advanced Usage

\`\`\`javascript
// Custom formatted message
await logger.sendMessage(
  '<b>Custom Alert</b>\\n' +
  '⚡ Something important happened!\\n' +
  '📊 Details: ...',
  { parse_mode: 'HTML' }
);

// Queue multiple messages (rate-limit safe)
await logger.queueMessage('Message 1');
await logger.queueMessage('Message 2');
await logger.queueMessage('Message 3');
// Messages will be sent with 1 second delay between each
\`\`\`

---

## 🐛 Troubleshooting

### Bot tidak mengirim log ke Telegram

1. Pastikan Bot Token dan Chat ID benar
2. Pastikan bot sudah di-start (`/start`) di Telegram
3. Cek console untuk error message
4. Test manual dengan:
   \`\`\`bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Test"
   \`\`\`

### UI tidak menampilkan log

1. Pastikan monitor server sudah running (`npm run monitor`)
2. Refresh browser (Ctrl+F5)
3. Cek browser console untuk error
4. Klik tombol "Refresh" di UI

### Port sudah digunakan

Ubah port dengan environment variable `MONITOR_PORT`

### Telegram Rate Limit

Jika terlalu banyak log dalam waktu singkat, Telegram akan rate limit. Logger sudah menggunakan queue system dengan delay 1 detik antar message.

---

## 📝 Format Log di Telegram

Log akan muncul di Telegram dengan format:

\`\`\`
ℹ️ INFO
🕐 10/04/2026, 20:30:45
[A1/10] Transaction completed successfully
\`\`\`

\`\`\`
❌ ERROR
🕐 10/04/2026, 20:31:12
[A2/10] Failed to connect to server
\`\`\`

\`\`\`
✅ SUCCESS
🕐 10/04/2026, 20:32:00
[A3/10] Balance updated: 1000 CC
\`\`\`

---

## 🎯 Tips & Best Practices

1. **Gunakan Group Chat** - Buat Telegram group khusus untuk bot logs
2. **Filter Logs** - Gunakan filter di UI untuk fokus pada log tertentu
3. **Auto-refresh** - UI auto-refresh setiap 30 detik, tidak perlu manual refresh
4. **Clear Logs** - Clear logs secara berkala jika sudah terlalu banyak
5. **Multiple Devices** - Buka UI dari device lain di network yang sama (gunakan IP lokal)
6. **Backup Logs** - Log di Telegram tersimpan permanen, bisa dilihat kapan saja

---

## 📊 Monitoring dari Mobile

Karena log dikirim ke Telegram, Anda bisa monitoring langsung dari HP:

1. Buka Telegram di HP
2. Lihat chat dengan bot Anda
3. Semua log akan muncul real-time
4. Atau buka browser di HP dan akses UI monitor

---

## 🔐 Security Notes

- **Jangan share Bot Token** - Token adalah credential sensitif
- **Private Chat** - Gunakan private chat atau group private untuk bot
- **Environment Variables** - Untuk production, gunakan env vars:
  \`\`\`bash
  export TELEGRAM_BOT_TOKEN="your_token"
  export TELEGRAM_CHAT_ID="your_chat_id"
  \`\`\`

---

## 📦 File Structure

\`\`\`
akar/
├── telegram-logger.js      # Telegram logger module
├── telegram-monitor.js     # Monitor server + UI
├── config.json            # Configuration (with telegram settings)
├── index.js               # Main bot (integrate logger here)
├── package.json           # Dependencies
└── TELEGRAM_MONITOR.md    # This documentation
\`\`\`

---

## 🆘 Support

Jika ada masalah:
1. Cek dokumentasi ini
2. Cek console untuk error message
3. Test Telegram API manual
4. Pastikan semua dependencies ter-install

---

**Dibuat untuk memudahkan monitoring RootsFi Bot via Telegram 🚀📱**
