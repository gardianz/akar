# 🤖 RootsFi Bot - Telegram Monitoring

Bot otomatis untuk RootsFi dengan monitoring real-time via Telegram dan Web UI.

## ✨ Features

- 🚀 **Auto Send** - Transaksi otomatis internal/external
- 📅 **Daily Check-in** - Check-in otomatis setiap hari
- 📱 **Telegram Integration** - Dashboard dan log dikirim ke Telegram
- 🌐 **Web Monitoring** - UI web untuk monitoring log real-time
- 📊 **Statistics** - Track success/failed transactions
- 🎯 **Smart Filtering** - Hanya log penting yang dikirim
- 📋 **Table Format** - Dashboard rapi dengan format tabel

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/gardianz/akar.git
cd akar
npm install
```

### 2. Setup Telegram

**Buat Bot:**
1. Buka Telegram, cari `@BotFather`
2. Kirim `/newbot` dan ikuti instruksi
3. Simpan Bot Token

**Dapatkan Chat ID:**
1. Kirim pesan ke bot Anda
2. Buka: `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
3. Cari `"chat":{"id":` dan simpan Chat ID

### 3. Configure

Edit `config.json`:

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "chatId": "987654321"
  },
  "send": {
    "maxLoopTx": 342,
    "minDelayTxSeconds": 1,
    "maxDelayTxSeconds": 5,
    "delayCycleSeconds": 55,
    "randomAmount": {
      "enabled": true,
      "min": "26",
      "max": "27",
      "decimals": 2
    }
  }
}
```

Edit `accounts.json`:

```json
{
  "accounts": [
    {
      "name": "Account1",
      "email": "your@email.com",
      "address": "alias::1220abcd..."
    }
  ]
}
```

### 4. Run

```bash
# Main bot
npm start

# Check-in bot
node checkin.js

# Web monitor (optional)
npm run monitor
```

## 📱 Telegram Dashboard

Bot akan otomatis mengirim dashboard ke Telegram:

### Main Bot Dashboard
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
```

### Check-in Summary
```
🎯 RootsFi Daily Check-In
📅 10/4/2026, 19.39.48 WIB
👥 9 accounts

Account         Status  Streak Points Tier
──────────────────────────────────────────────────
gardiansrizz    OK      1d     1      Newbie
firman          DONE    1d     0      Newbie
ardiwibowo016   OK      1d     1      Newbie

✅ Success: 9 | ❌ Failed: 0
```

### Cycle Complete
```
📊 Cycle #1 Complete

✅ Success: 95
❌ Failed: 5
⏱ Duration: 2h 15m 30s
🔄 Next cycle: 2026-04-11 00:00:00 UTC
```

## 🌐 Web Monitoring UI

Jalankan monitor server:

```bash
npm run monitor
```

Buka browser: `http://localhost:3000`

**Features:**
- Real-time log dari Telegram
- Filter by level (INFO/SUCCESS/WARN/ERROR)
- Statistics dashboard
- Auto-refresh setiap 30 detik
- Responsive design

## 📂 Project Structure

```
akar/
├── index.js                    # Main bot
├── checkin.js                  # Check-in bot
├── telegram-logger.js          # Telegram logger module
├── telegram-monitor.js         # Web UI monitor
├── telegram-integration.js     # Smart integration
├── config.json                 # Configuration
├── accounts.json               # Account list
├── tokens.json                 # Generated tokens
├── recipient.txt               # External recipients
└── docs/
    ├── QUICK_START.md          # Quick start guide
    ├── TELEGRAM_MONITOR.md     # Monitor documentation
    ├── INTEGRATION_GUIDE.md    # Integration guide
    └── SUMMARY.md              # Complete summary
```

## 🔧 Configuration

### Telegram Settings

```json
{
  "telegram": {
    "enabled": true,              // Enable/disable Telegram
    "botToken": "YOUR_BOT_TOKEN", // From @BotFather
    "chatId": "YOUR_CHAT_ID"      // Your Telegram chat ID
  }
}
```

### Send Settings

```json
{
  "send": {
    "maxLoopTx": 342,             // Max transactions per cycle
    "minDelayTxSeconds": 1,       // Min delay between TX
    "maxDelayTxSeconds": 5,       // Max delay between TX
    "delayCycleSeconds": 55,      // Delay between cycles
    "sequentialAllRounds": true,  // Sequential processing
    "randomAmount": {
      "enabled": true,            // Random amount
      "min": "26",                // Min amount
      "max": "27",                // Max amount
      "decimals": 2               // Decimal places
    }
  }
}
```

### UI Settings

```json
{
  "ui": {
    "dashboard": true,            // Enable dashboard
    "logLines": 20                // Number of log lines
  }
}
```

## 📖 Documentation

- [QUICK_START.md](QUICK_START.md) - Panduan cepat setup
- [TELEGRAM_MONITOR.md](TELEGRAM_MONITOR.md) - Dokumentasi monitoring UI
- [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) - Panduan integrasi
- [SUMMARY.md](SUMMARY.md) - Summary lengkap

## 🐛 Troubleshooting

### Log tidak muncul di Telegram

```bash
# Test manual
curl "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Test"

# Cek config
cat config.json | grep telegram

# Harus muncul di console:
[Telegram] Logger initialized
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
Solusi: Kirim pesan ke bot dulu, lalu cek Chat ID

### Rate limit
```
Error: 429 Too Many Requests
```
Solusi: Logger sudah pakai queue dengan delay 1 detik

## 🔐 Security

- Jangan share Bot Token
- Gunakan private chat atau group
- Simpan credentials di environment variables untuk production:

```bash
export TELEGRAM_BOT_TOKEN="your_token"
export TELEGRAM_CHAT_ID="your_chat_id"
```

## 📊 Statistics

- **Total Files:** 12+ files
- **Total Lines:** 4500+ lines
- **Integration Points:** 3 (index.js, checkin.js, monitor)
- **Documentation:** 4 comprehensive guides

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.

## 📝 License

MIT

## 🙏 Credits

Built for RootsFi automation with ❤️

---

**Ready to use! Setup Telegram dan jalankan bot! 🚀**

Repository: https://github.com/gardianz/akar
