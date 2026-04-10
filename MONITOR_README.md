# RootsFi Bot - Monitoring UI

UI monitoring untuk memantau log dan status bot RootsFi secara real-time.

## 🚀 Cara Menggunakan

### Opsi 1: Jalankan Monitor Terpisah (Recommended)

1. **Jalankan Monitor Server**
   ```bash
   npm run monitor
   ```
   Atau double-click file `start-monitor.bat`

2. **Jalankan Bot** (di terminal/command prompt lain)
   ```bash
   npm start
   ```

3. **Buka Browser**
   Akses: `http://localhost:3000`

### Opsi 2: Jalankan Monitor Otomatis dengan Bot

Tambahkan baris ini di awal file `index.js` (setelah baris 1):

```javascript
require('./monitor-server.js');
```

Maka setiap kali bot jalan, monitor server juga akan aktif otomatis.

## 📊 Fitur Monitor UI

### Dashboard Utama
- ✅ **Status Bot** - Indikator running/stopped dengan animasi
- ✅ **Statistik Real-time** - Total transaksi, berhasil, gagal
- ✅ **Jumlah Akun** - Akun yang sedang aktif

### Log Monitoring
- ✅ **Real-time Updates** - Log muncul otomatis tanpa refresh
- ✅ **Color-coded Levels**:
  - 🔵 INFO - Informasi umum (biru)
  - 🟡 WARN - Peringatan (kuning)
  - 🔴 ERROR - Error (merah)
- ✅ **Timestamp** - Waktu setiap log dengan format lokal
- ✅ **Account Tags** - Menampilkan akun yang sedang diproses
- ✅ **Filter** - Filter berdasarkan level (ALL/INFO/WARN/ERROR)
- ✅ **Clear Logs** - Hapus semua log dengan satu klik
- ✅ **Auto-scroll** - Scroll otomatis ke log terbaru

### Tampilan
- ✅ **Responsive Design** - Menyesuaikan ukuran layar
- ✅ **Modern UI** - Gradient background, card-based layout
- ✅ **Smooth Animations** - Transisi halus untuk log baru
- ✅ **Custom Scrollbar** - Scrollbar yang lebih estetik

## ⚙️ Konfigurasi

### Custom Port

Jika port 3000 sudah digunakan, ubah dengan environment variable:

**Windows (Command Prompt):**
```cmd
set MONITOR_PORT=8080 && npm run monitor
```

**Windows (PowerShell):**
```powershell
$env:MONITOR_PORT=8080; npm run monitor
```

**Linux/Mac:**
```bash
MONITOR_PORT=8080 npm run monitor
```

### API Endpoints

Monitor server menyediakan API untuk integrasi:

- `GET /` - UI Dashboard
- `GET /api/logs` - Ambil semua log (JSON)
- `GET /api/status` - Status bot (JSON)
- `GET /api/stream` - SSE stream untuk real-time updates
- `POST /api/status` - Update status bot

## 🔧 Integrasi dengan Bot

Jika ingin mengirim log custom dari bot ke monitor:

```javascript
const monitor = require('./monitor-server.js');

// Tambah log
monitor.addLog('INFO', 'Custom log message', 'A1/10');

// Update status
monitor.updateStatus({
  isRunning: true,
  accounts: ['account1', 'account2'],
  stats: {
    total: 100,
    success: 95,
    failed: 5
  }
});
```

## 📱 Screenshot

Dashboard menampilkan:
- Header dengan status dan waktu update
- 4 kartu statistik (Total, Berhasil, Gagal, Akun)
- Log container dengan filter dan tombol clear
- Log entries dengan warna berbeda per level

## 🐛 Troubleshooting

### Port sudah digunakan
Ubah port dengan `MONITOR_PORT` environment variable.

### Log tidak muncul
Pastikan bot sudah berjalan dan menggunakan `console.log()` untuk logging.

### Browser tidak bisa akses
Cek firewall atau gunakan `http://127.0.0.1:3000` sebagai alternatif.

## 📝 Notes

- Monitor server menggunakan Server-Sent Events (SSE) untuk real-time updates
- Log disimpan di memory (max 1000 entries)
- Refresh browser tidak akan menghilangkan log yang sudah ada
- Monitor server bisa dijalankan terpisah dari bot utama

## 🎯 Tips

1. Buka monitor di browser sebelum menjalankan bot untuk melihat semua log dari awal
2. Gunakan filter untuk fokus pada log tertentu (misal: hanya ERROR)
3. Clear logs secara berkala jika sudah terlalu banyak
4. Monitor bisa diakses dari device lain di network yang sama (gunakan IP lokal)

---

Dibuat untuk memudahkan monitoring RootsFi Bot 🚀
