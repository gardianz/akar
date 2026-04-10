# Cara Integrasi Telegram Logger ke Bot

## Opsi 1: Integrasi Otomatis (Recommended)

Tambahkan satu baris di **paling awal** file `index.js` (baris ke-2, setelah `"use strict";`):

```javascript
#!/usr/bin/env node
"use strict";

require('./telegram-integration.js'); // <-- TAMBAHKAN BARIS INI

const fs = require("node:fs/promises");
// ... kode lainnya
```

Selesai! Bot akan otomatis mengirim log penting ke Telegram.

## Opsi 2: Manual Integration

Jika ingin kontrol lebih detail, edit `index.js` secara manual:

### 1. Di bagian paling atas (setelah require statements):

```javascript
const TelegramLogger = require('./telegram-logger.js');
let telegramLogger = null;

// Initialize after config loaded
function initTelegramLogger(config) {
  if (config.telegram && config.telegram.enabled) {
    telegramLogger = new TelegramLogger(config.telegram);
    console.log('[Telegram] Logger initialized');
  }
}
```

### 2. Setelah config di-load, panggil init:

```javascript
// Setelah baris: const config = await readJson(...)
initTelegramLogger(config);
```

### 3. Kirim log di tempat-tempat penting:

```javascript
// Contoh: Saat processing account
if (telegramLogger) {
  await telegramLogger.info(`Processing ${account.name}`, `A${index}/${total}`);
}

// Contoh: Saat transaksi berhasil
if (telegramLogger) {
  await telegramLogger.success(`Transfer ${amount} CC completed`, accountTag);
}

// Contoh: Saat error
if (telegramLogger) {
  await telegramLogger.error(`Transaction failed: ${error.message}`, accountTag);
}

// Contoh: Kirim statistik
if (telegramLogger) {
  await telegramLogger.sendStats({
    total: globalSwapsTotal,
    success: globalSwapsOk,
    failed: globalSwapsFail,
    accounts: accounts.length
  });
}
```

## Log yang Akan Dikirim ke Telegram

Dengan integrasi otomatis, hanya log **penting** yang dikirim:

✅ **Dikirim:**
- Processing account
- Balance info
- Send transaction
- Transfer completed/failed
- Cooldown info
- Weekly rewards
- Round info
- Errors & warnings

❌ **Tidak dikirim:**
- Debug info
- Cookie status
- Session details
- Internal technical logs

## Format Log di Telegram

```
ℹ️ INFO | 10/04/2026, 20:30:45
[A9/9] Processing thegardians

✅ SUCCESS | 10/04/2026, 20:31:12
[A9/9] Transfer 83.50 CC completed

❌ ERROR | 10/04/2026, 20:32:00
[A9/9] Transaction failed: Insufficient balance
```

## Testing

Setelah integrasi, test dengan:

```bash
# Jalankan bot
npm start

# Cek Telegram - seharusnya muncul:
# 🚀 RootsFi Bot Started
# 👥 Accounts: 9
# 🕐 10/04/2026, 20:30:00
```

## Troubleshooting

### Log tidak muncul di Telegram

1. Cek config.json:
```json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456789:ABCdef...",
    "chatId": "987654321"
  }
}
```

2. Test manual:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Test"
```

3. Cek console untuk error:
```
[Telegram] Logger initialized  ✅ Good
[Telegram] Logger disabled     ❌ Check config
```

### Terlalu banyak log

Edit `telegram-integration.js`, ubah `isImportant` logic:

```javascript
// Hanya kirim error dan success
info.isImportant = lowerMsg.includes('error') || 
                   lowerMsg.includes('success') ||
                   lowerMsg.includes('completed');
```

### Rate limit Telegram

Telegram limit: 30 messages/second. Logger sudah menggunakan queue dengan delay 1 detik antar message.

Jika masih kena limit, tambah delay di `telegram-logger.js`:

```javascript
this.rateLimitDelay = 2000; // 2 seconds
```

## Custom Log

Kirim log custom dari code:

```javascript
const { sendTelegramLog } = require('./telegram-integration.js');

// Di dalam function
await sendTelegramLog('INFO', 'Custom message', 'A1/9');
await sendTelegramLog('SUCCESS', 'Operation completed', 'A2/9');
await sendTelegramLog('ERROR', 'Something went wrong', 'A3/9');
```

---

**Pilih Opsi 1 untuk kemudahan, atau Opsi 2 untuk kontrol penuh!**
