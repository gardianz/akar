# 🚀 Quick Start - Telegram Integration

Bot sudah terintegrasi langsung dengan Telegram! Anda tinggal jalankan saja.

## ✅ Yang Sudah Dilakukan:

1. ✅ `index.js` - Sudah terintegrasi Telegram logger
2. ✅ `checkin.js` - Sudah terintegrasi Telegram logger
3. ✅ Dashboard otomatis dikirim ke Telegram setiap cycle selesai
4. ✅ Format tabel rapi dengan monospace font

## 📱 Setup Telegram (Sekali Saja):

### 1. Buat Bot Telegram
```bash
# Di Telegram, cari @BotFather
# Kirim: /newbot
# Ikuti instruksi
# Simpan Bot Token: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

### 2. Dapatkan Chat ID
```bash
# Kirim pesan ke bot Anda
# Buka browser:
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates

# Cari "chat":{"id": di response
# Simpan Chat ID: 987654321
```

### 3. Edit config.json
```json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "chatId": "987654321"
  }
}
```

## 🎯 Jalankan Bot:

```bash
# Pull update dari GitHub
git pull origin main

# Install dependencies (jika belum)
npm install

# Jalankan bot
npm start
# atau
node index.js

# Jalankan check-in bot
node checkin.js
```

## 📊 Log yang Dikirim ke Telegram:

### Check-in Bot (checkin.js):
```
🎯 RootsFi Daily Check-In
📅 10/4/2026, 19.39.48 WIB
👥 9 accounts

Account         Status  Streak Points Tier
──────────────────────────────────────────────────
gardiansrizz    OK      1d     1      Newbie
firman          DONE    1d     0      Newbie
ardiwibowo016   OK      1d     1      Newbie
ervansugiarto04 OK      1d     1      Newbie
thegardians     OK      1d     1      Newbie
aninurcahayani  OK      1d     1      -
mulyanayanu     OK      1d     1      -
getgrass        OK      1d     1      -
mattdanu        OK      1d     1      -

✅ Success: 9 | ❌ Failed: 0
```

### Main Bot (index.js):
```
🤖 RootsFi Bot Dashboard
📅 10/4/2026, 20:30:45 WIB
👥 9 accounts | Mode: INTERNAL
📊 Sends: 100 (✅95 ❌5)

Account         Status    CC        TX
─────────────────────────────────────────────
gardiansrizz    IDLE      179.83    10 (ok:9|fail:1)
firman          SEND      156.42    12 (ok:12|fail:0)
ardiwibowo016   IDLE      203.15    8 (ok:8|fail:0)
...
```

### Cycle Complete:
```
📊 Cycle #1 Complete

✅ Success: 95
❌ Failed: 5
⏱ Duration: 2h 15m 30s
🔄 Next cycle: 2026-04-11 00:00:00 UTC
```

## 🔧 Troubleshooting:

### Log tidak muncul di Telegram
```bash
# Test manual
curl "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Test"

# Cek config.json
cat config.json | grep telegram

# Cek console saat bot start
# Harus muncul: [Telegram] Logger initialized
```

### Bot Token salah
```
Error: 401 Unauthorized
```
Solusi: Cek Bot Token di config.json

### Chat ID salah
```
Error: 400 Bad Request: chat not found
```
Solusi: 
1. Kirim pesan ke bot dulu
2. Cek Chat ID dengan getUpdates
3. Update config.json

### Rate limit
```
Error: 429 Too Many Requests
```
Solusi: Logger sudah pakai queue dengan delay 1 detik. Tunggu sebentar.

## 📝 Disable Telegram (Sementara):

Edit `config.json`:
```json
{
  "telegram": {
    "enabled": false,
    "botToken": "...",
    "chatId": "..."
  }
}
```

## 🎨 Customize Format:

Edit `telegram-logger.js` untuk mengubah format pesan.

Edit `index.js` atau `checkin.js` untuk mengubah kapan dashboard dikirim.

---

**Sekarang tinggal jalankan bot, dashboard otomatis terkirim ke Telegram! 🎉**
