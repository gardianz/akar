# 🔧 Troubleshooting - Telegram Dashboard Not Sending

## ✅ Checklist Debugging

Jalankan bot dan perhatikan log console. Anda harus melihat:

```
[Telegram] Logger initialized successfully
[Telegram] Bot Token: SET
[Telegram] Chat ID: SET
[Telegram] Start notification sent
[Telegram] Test message sent
```

Jika tidak melihat ini, ikuti langkah di bawah.

---

## 🐛 Problem 1: Telegram Logger Not Initialized

### Symptoms:
```
[Telegram] Logger not enabled or module not found
```

### Solution:

1. **Check config.json:**
```bash
cat config.json | grep -A 5 telegram
```

Harus ada:
```json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "chatId": "987654321"
  }
}
```

2. **Check telegram-logger.js exists:**
```bash
ls -la telegram-logger.js
```

3. **Check dependencies installed:**
```bash
npm list node-telegram-bot-api
```

Jika tidak ada:
```bash
npm install node-telegram-bot-api axios
```

---

## 🐛 Problem 2: Bot Token or Chat ID Wrong

### Symptoms:
```
[Telegram] Failed to initialize: 401 Unauthorized
[Telegram] Failed to initialize: 400 Bad Request
```

### Solution:

1. **Test Bot Token manually:**
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe"
```

Harus return:
```json
{"ok":true,"result":{"id":123456789,"is_bot":true,"first_name":"YourBot",...}}
```

Jika error 401: Bot Token salah, buat bot baru di @BotFather

2. **Test Chat ID manually:**
```bash
# Kirim pesan test
curl "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Test"
```

Harus return:
```json
{"ok":true,"result":{"message_id":123,...}}
```

Jika error 400: Chat ID salah

3. **Get correct Chat ID:**
```bash
# Kirim pesan ke bot Anda di Telegram dulu
# Lalu:
curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates"
```

Cari `"chat":{"id":987654321` → itu Chat ID Anda

---

## 🐛 Problem 3: Dashboard Not Sending

### Symptoms:
```
[Telegram] Logger initialized successfully
[Telegram] Test message sent
```
Tapi dashboard tidak terkirim setelah round selesai.

### Solution:

1. **Check log saat round selesai:**

Harus muncul:
```
[cycle] Round 1/100 completed. Waiting 55s before next round...
[cycle] Sending dashboard to Telegram...
[Telegram] Preparing to send dashboard...
[Telegram] Sending dashboard message...
[Telegram] Dashboard sent successfully!
```

Jika tidak muncul `[cycle] Sending dashboard to Telegram...`:
- Dashboard object tidak ter-inisialisasi
- Check apakah `ui.dashboard` di config.json = true

2. **Force send dashboard manually:**

Tambahkan di index.js setelah baris `await telegramLogger.sendStartNotification(...)`:

```javascript
// Test dashboard send
if (dashboard) {
  console.log('[Test] Sending test dashboard...');
  await dashboard.sendDashboardToTelegram();
}
```

3. **Check dashboard state:**

Tambahkan log:
```javascript
console.log('[Debug] Dashboard state:', dashboard.state);
console.log('[Debug] Account rows:', dashboard.parseAccountRows());
```

---

## 🐛 Problem 4: Message Format Error

### Symptoms:
```
[Telegram] Failed to send dashboard: Bad Request: can't parse entities
```

### Solution:

HTML entities tidak valid. Edit `index.js`, method `sendDashboardToTelegram()`:

Ganti:
```javascript
message += `<pre>`;
```

Dengan:
```javascript
message += `<code>`;
```

Dan:
```javascript
message += `</pre>`;
```

Dengan:
```javascript
message += `</code>`;
```

---

## 🐛 Problem 5: Rate Limit

### Symptoms:
```
[Telegram] Failed to send: 429 Too Many Requests
```

### Solution:

Telegram limit: 30 messages/second. Logger sudah pakai queue.

Jika masih kena limit, edit `telegram-logger.js`:

```javascript
this.rateLimitDelay = 2000; // Ubah dari 1000 ke 2000 (2 detik)
```

---

## 🧪 Manual Test Script

Buat file `test-telegram.js`:

```javascript
const TelegramLogger = require('./telegram-logger.js');
const config = require('./config.json');

async function test() {
  console.log('Testing Telegram integration...');
  console.log('Config:', config.telegram);
  
  const logger = new TelegramLogger(config.telegram);
  
  // Test 1: Simple message
  console.log('Test 1: Sending simple message...');
  await logger.sendMessage('Test message from bot');
  
  // Test 2: HTML message
  console.log('Test 2: Sending HTML message...');
  await logger.sendMessage('<b>Bold</b> and <code>code</code>', { parse_mode: 'HTML' });
  
  // Test 3: Dashboard format
  console.log('Test 3: Sending dashboard...');
  const message = `<b>🤖 Test Dashboard</b>\n\n<pre>Account         Status\ntest            OK</pre>`;
  await logger.sendMessage(message, { parse_mode: 'HTML' });
  
  console.log('All tests completed!');
}

test().catch(console.error);
```

Jalankan:
```bash
node test-telegram.js
```

---

## 📋 Complete Debugging Checklist

- [ ] `telegram-logger.js` exists
- [ ] `node-telegram-bot-api` installed (`npm list node-telegram-bot-api`)
- [ ] `config.json` has telegram section with `enabled: true`
- [ ] Bot Token is correct (test with curl)
- [ ] Chat ID is correct (test with curl)
- [ ] Bot started successfully (see `[Telegram] Test message sent`)
- [ ] Dashboard object initialized (`ui.dashboard: true` in config)
- [ ] Round completed (see `[cycle] Round X/Y completed`)
- [ ] Dashboard send triggered (see `[cycle] Sending dashboard to Telegram...`)
- [ ] No HTML parse errors
- [ ] No rate limit errors

---

## 🆘 Still Not Working?

### Enable Full Debug Mode:

Edit `index.js`, tambahkan di bagian atas:

```javascript
// Debug mode
process.env.DEBUG = 'telegram:*';
```

Edit `telegram-logger.js`, tambahkan logging:

```javascript
async sendMessage(text, options = {}) {
  console.log('[Telegram Debug] Sending message:', text.substring(0, 100));
  console.log('[Telegram Debug] Options:', options);
  console.log('[Telegram Debug] Bot Token:', this.botToken ? 'SET' : 'NOT SET');
  console.log('[Telegram Debug] Chat ID:', this.chatId);
  
  // ... rest of code
}
```

### Check Bot Permissions:

1. Buka Telegram
2. Cari bot Anda
3. Kirim `/start`
4. Pastikan bot bisa reply

### Check Network:

```bash
# Test koneksi ke Telegram API
curl -I https://api.telegram.org

# Harus return: HTTP/2 200
```

### Last Resort - Recreate Bot:

1. Buka @BotFather
2. `/newbot` - buat bot baru
3. Dapatkan Bot Token baru
4. Update config.json
5. Restart bot

---

**Jika masih tidak work, share log lengkap dari console!**
