# CUT DIFF 2.0 — Panduan Lengkap

**PostFlowX · Diff & Perbandingan Editorial**

---

## Daftar Isi

1. [Apa itu Cut Diff 2.0?](#1-apa-itu-cut-diff-20)
2. [Memuat Timeline](#2-memuat-timeline)
3. [Menjalankan Diff](#3-menjalankan-diff)
4. [Memahami Tipe Diff](#4-memahami-tipe-diff)
5. [Penilaian Risiko](#5-penilaian-risiko)
6. [Membaca Timeline](#6-membaca-timeline)
7. [Shot Cut & Cara Mengidentifikasinya](#7-shot-cut--cara-mengidentifikasinya)
8. [Tabel Diff](#8-tabel-diff)
9. [Panel Inspektor](#9-panel-inspektor)
10. [Perbandingan Video](#10-perbandingan-video)
11. [Filter](#11-filter)
12. [Alur Kerja Status & Catatan](#12-alur-kerja-status--catatan)
13. [Ekspor](#13-ekspor)
14. [Pintasan Keyboard](#14-pintasan-keyboard)
15. [Tips & Contoh Alur Kerja](#15-tips--contoh-alur-kerja)

---

## 1. Apa itu Cut Diff 2.0?

Cut Diff 2.0 membandingkan dua versi timeline yang telah diedit — sebuah **cut LAMA (OLD)** dan **cut BARU (NEW)** — dan menunjukkan persis apa yang berubah di antara keduanya. Alat ini menjawab:

- Klip mana yang ditambahkan, dihapus, atau diganti?
- Shot mana yang diperpanjang atau diperpendek?
- Berapa banyak waktu tayang yang ditambahkan atau dihapus?
- Perubahan mana yang berisiko tinggi dan memerlukan perhatian segera dari VFX/audio/musik?

Dirancang untuk **serah terima editorial**: koordinator VFX, asisten editor, editor suara, dan pengawas musik yang perlu memahami revisi picture lock dengan cepat.

**Format file yang didukung**: EDL (CMX 3600), FCPXML, ALE, ekspor XML timeline dari DaVinci Resolve, Avid, Premiere, dan Final Cut Pro X.

---

## 2. Memuat Timeline

### Zona Drop

Di bagian atas tab Anda akan melihat dua zona drop:

```
┌────────────────────┐   ┌────────────────────┐
│  Drop Timeline LAMA│   │  Drop Timeline BARU │
│   atau klik Browse │   │   atau klik Browse  │
└────────────────────┘   └────────────────────┘
```

- **Zona kiri = OLD** — versi sebelumnya (referensi/baseline Anda)
- **Zona kanan = NEW** — versi terbaru yang Anda terima dari editorial

Seret-dan-lepas file ke setiap zona, atau klik **Browse** untuk memilih file. Ketika file dimuat, nama filenya muncul di zona dan zona berubah warna menjadi highlighted.

### File mana yang OLD dan mana yang NEW?

Selalu muat versi **lebih lama** sebagai OLD dan versi **lebih baru** sebagai NEW. Arah diff penting: sebuah event ditandai EXTENDED ketika klip NEW lebih panjang dari klip OLD. Jika dimuat terbalik, semua label EXTENDED/TRIMMED akan terbalik.

### Memuat File Video (opsional tapi direkomendasikan)

Di bawah zona drop terdapat panel **Video Compare**. Anda dapat secara opsional men-drop atau menelusuri file video aktual untuk OLD dan NEW. Ini mengaktifkan:

- Filmstrip thumbnail yang akurat per frame pada timeline
- Perbandingan video side-by-side / wipe / difference
- Grafik content diff tingkat piksel di bawah timeline

File video disimpan di IndexedDB browser sehingga diingat antar sesi.

---

## 3. Menjalankan Diff

Klik tombol **Analyze** di header. Ini memicu mesin diff yang:

1. Mem-parse semua klip dari kedua timeline
2. Mencocokkan setiap klip NEW dengan pasangan terbaik OLD berdasarkan **identitas klip** (nama klip + reel)
3. Mengklasifikasikan setiap kecocokan ke dalam tipe diff (NEW, EXTENDED, CHANGED, TRIMMED)
4. Menghitung **skor risiko** untuk setiap perubahan
5. Merender bar KPI, timeline, dan tabel

Diff berjalan sepenuhnya di browser — tidak ada unggahan, tidak ada server.

### Bar KPI

Setelah menganalisis, deretan kartu metrik muncul:

| Kartu | Yang Ditampilkan |
|-------|-----------------|
| **NEW** | Klip yang muncul di NEW tetapi tidak ada klip yang cocok di OLD |
| **EXTENDED** | Klip yang durasinya bertambah antara OLD dan NEW |
| **CHANGED** | Nama klip sama, materi sumber atau take berbeda |
| **TRIMMED** | Klip yang durasinya berkurang |
| **HIGH RISK** | Event yang memerlukan perhatian segera (lihat §5) |
| **+DUR** | Total waktu tayang yang ditambahkan (frame NEW + EXTENDED) |
| **−DUR** | Total waktu tayang yang dihapus (frame TRIMMED) |
| **% Changed** | Fraksi cut yang telah berubah |

---

## 4. Memahami Tipe Diff

Mesin membandingkan setiap klip NEW terhadap klip OLD dengan **nama klip dan reel yang sama**. Ketika kecocokan ditemukan, durasi dan titik source-in dibandingkan dalam toleransi kecil (±2 frame durasi, ±4 frame source-in).

### NEW
```
OLD: [tidak ada]
NEW: [████████ CLIP_A ████████]
```
Klip ada di NEW tetapi **tidak ada klip dengan identitas yang sama** di mana pun di OLD. Semua event NEW secara otomatis **RISIKO TINGGI**.

### EXTENDED
```
OLD: [████████ CLIP_B ████████]         (200 frame)
NEW: [█████████████ CLIP_B █████████]   (260 frame + 60 frame ditambahkan)
```
Klip yang sama, tetapi cut NEW **lebih panjang**. Untuk VFX ini biasanya berarti jendela kerja VFX perlu diperluas.

### TRIMMED
```
OLD: [█████████████ CLIP_C █████████]   (180 frame)
NEW: [████ CLIP_C ████]                  (80 frame — 100 frame dihapus)
```
Klip yang sama, tetapi cut NEW **lebih pendek**. Untuk VFX, pekerjaan mungkin sekarang dimulai lebih lambat atau berakhir lebih awal dari yang dianggarkan.

### CHANGED
```
OLD: [████ CLIP_D (srcIn=00:42:15:00) ████]
NEW: [████ CLIP_D (srcIn=01:12:30:08) ████]   nama sama, sumber benar-benar berbeda
```
Nama klip sama, tetapi timecode sumber (srcIn) berbeda lebih dari toleransi. Ini menunjukkan: take yang berbeda, versi yang di-retime atau di-regrade, atau klip yang diganti dengan nama yang sama.

### UNCHANGED
```
OLD: [████ CLIP_E ████]  (srcIn=00:10:00:00, dur=120fr)
NEW: [████ CLIP_E ████]  (srcIn=00:10:00:00, dur=120fr) — identik
```
Klip sama di kedua cut dalam toleransi. Secara default, event UNCHANGED **disembunyikan dari tabel**.

---

## 5. Penilaian Risiko

Setiap event diff mendapat tingkat risiko berdasarkan artinya bagi pekerjaan downstream.

### Tingkat Risiko

| Tingkat | Warna | Aturan |
|---------|-------|--------|
| **TINGGI** | 🔴 Merah | Event NEW mana pun **atau** event yang berlangsung lebih dari 240 frame (~10 dtk pada 24fps) |
| **SEDANG** | 🟡 Amber | Durasi event 48–240 frame (~2–10 detik) |
| **RENDAH** | 🟢 Hijau | Durasi event di bawah 48 frame (~2 detik) |

### Skor Kecocokan (% Kepercayaan)

Untuk event EXTENDED, CHANGED, dan TRIMMED, mesin juga melaporkan **kepercayaan kecocokan** antara 0–100%:

- **100%**: Kecocokan sempurna
- **75–99%**: Trim kecil atau penyesuaian sumber kecil — kepercayaan tinggi
- **50–74%**: Perbedaan sedang — perlu diperiksa ulang
- **< 50%**: Perbedaan besar — mungkin kecocokan yang salah

Skor dihitung sebagai:
`(kemiripan durasi × 60%) + (kemiripan source-in × 40%)`

---

## 6. Membaca Timeline

Timeline adalah bagian paling kuat dari Cut Diff 2.0. Ini menampilkan **kedua** cut OLD dan NEW secara berdampingan sebagai track horizontal.

### Tata Letak Timeline (atas ke bawah)

```
┌─────────────────────────────────────────────────────────────┐
│ RULER  │ 00:00   00:30   01:00   01:30   02:00              │ ← Penggaris timecode
├────────────────────────────────────────────────────────────┤
│  OLD ░░░░▓▓▓▓▓░░▓▓▓▓░░░░░░▓▓░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░░  │ ← Track OLD
│ ─────────────────── DIFF ──────────────────────────────────── │ ← Pemisah Diff
│  NEW ░░░▓▓▓▓░░░░░░░▓▓▓▓▓▓░░░▓░░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░  │ ← Track NEW
│ ▓▓▓░░░░▓▓▓░▓░▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ ← Strip Ringkasan
├────────────────────────────────────────────────────────────┤
│ Content diff ░░▓░░░░░░▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ ← Grafik Pixel diff
└─────────────────────────────────────────────────────────────┘
```

### Track NEW & Bar Warna Diff

Track NEW menampilkan setiap klip dengan **bar berwarna di bagian bawah** yang menunjukkan status diffnya:

| Warna | Tipe Diff | Arti |
|-------|-----------|------|
| 🔵 Cyan cerah | NEW | Belum pernah ada sebelumnya — tidak ada di OLD |
| 🟢 Hijau | EXTENDED | Klip ini tumbuh dibanding OLD |
| 🟡 Amber | CHANGED | Nama sama, sumber/take berbeda |
| 🟣 Ungu | TRIMMED | Klip ini menyusut dibanding OLD |
| ⬛ Sangat gelap | UNCHANGED | Identik dengan OLD |

**Stripe merah 2px di bagian atas** klip berarti RISIKO TINGGI.

### Grafik Content Diff

Grafik batang di bawah strip ringkasan menampilkan **kemiripan frame tingkat piksel** antara OLD dan NEW.

| Warna | Arti |
|-------|------|
| 🟢 Batang hijau | Frame terlihat hampir identik |
| 🟡 Batang amber | Perbedaan visual sedang |
| 🔴 Batang merah | Frame sangat berbeda secara visual |

---

## 7. Shot Cut & Cara Mengidentifikasinya

### Cara Melihat Shot Cut di Timeline

**Metode 1: Lihat titik awal/akhir klip di track NEW**

Ketika bar diff berwarna pada klip yang berdekatan memiliki tipe berbeda, ada perubahan titik edit yang berarti.

**Metode 2: Perbesar ke bagian yang berubah**

Gunakan **scroll roda untuk zoom** pada timeline. Saat diperbesar, penanda pada penggaris menjadi lebih halus dan shot individual menjadi terlihat.

**Metode 3: Perhatikan kluster di strip ringkasan**

Strip ringkasan menampilkan seluruh cut yang dikompresi menjadi satu bar. Kluster warna (cyan/amber/hijau) berarti zona revisi padat.

**Metode 4: Bandingkan tepi klip OLD dan NEW secara langsung**

Pilih event TRIMMED di tabel. Inspektor menampilkan nilai `RecIn`/`RecOut` untuk OLD dan NEW. Perbedaannya adalah seberapa banyak titik cut bergerak.

### Klip NEW yang Disisipkan Di Antara Shot yang Ada

Ketika klip NEW muncul di antara klip yang diketahui, timecode record-in klip berikutnya akan bergeser:

```
OLD:  [──A──|──B──|──C──]      B dimulai pada 01:00:00:00
NEW:  [──A──|NEW X|──B──|──C──]  B sekarang dimulai pada 01:00:12:00
```

B dalam cut NEW adalah UNCHANGED (konten sama) tetapi muncul LEBIH LAMBAT dalam program. Ini penting untuk:
- **Editor musik**: Cue yang membentur beat aksi B sekarang terlambat 12 detik
- **Editor suara**: Foley dan efek yang disinkronkan ke B perlu di-retime
- **VFX**: Shot VFX pada B sekarang dimainkan di posisi program yang berbeda

---

## 8. Tabel Diff

Tabel mencantumkan setiap event yang berubah sebagai baris.

### Panduan Kolom

| Kolom | Deskripsi |
|-------|-----------|
| **●** | Pip risiko — merah (tinggi), amber (sedang), hijau (rendah) |
| **Type** | Lencana NEW / EXT / CHG / TRM / UNC |
| **Reel** | Nama reel atau bin dari EDL/XML |
| **Clip** | Nama klip |
| **SrcIn** | Timecode sumber masuk |
| **Dur** | Durasi dalam frame |
| **Match%** | Skor kepercayaan (bar + %) — kosong untuk event NEW |
| **Status** | Status tinjauan Anda: — / ✓ / ⊘ / ? (klik untuk bersepeda) |
| **Note** | Bidang teks bebas (terlihat di inspektor) |

### Memilih Baris

Klik baris mana saja untuk:
1. **Membuka inspektor** (panel kanan) dengan detail event lengkap
2. **Memperbesar timeline** untuk memusatkan event tersebut
3. **Mencari video** ke timecode `RecIn` event (jika video dimuat)

---

## 9. Panel Inspektor

Klik baris mana saja untuk membuka inspektor di sisi kanan. Ini menampilkan rincian lengkap perubahan yang dipilih.

### Bidang

```
Event 3 / 47                 ← nomor event dari total
Type:    EXTENDED             ← klasifikasi diff
Reel:    A001                 ← nama reel
Clip:    105_08_06/01_AB      ← nama klip
SrcIn:   10:42:15:00          ← source start di NEW
SrcOut:  10:42:28:10          ← source end di NEW
RecIn:   01:02:45:00          ← record (program) start
RecOut:  01:02:58:10          ← record (program) end
Duration: 318 frame
FPS:      24
```

### Info Kecocokan (untuk EXTENDED / TRIMMED / CHANGED)

```
Match Score:  ████████░░  78%  ← bar kepercayaan
Reason:       Duration +48fr (+2.0s extended)
Old Clip:     105_08_06/01_AB  ← klip yang sama di OLD
Old SrcIn:    10:42:15:00      ← source start di OLD
Old RecIn:    01:02:45:00      ← record start di OLD
```

### Status & Catatan

**Status** (klik atau tekan Enter untuk bersepeda):
- **—** (tidak ada): Belum ditinjau
- **✓** (ok): Dikonfirmasi, tidak perlu tindakan
- **⊘** (skip): Masalah diketahui, lewati di pass ini
- **?** (query): Perlu tindak lanjut atau diskusi

Catatan muncul di ekspor PDF dan XLSX, sehingga Anda dapat menulis satu baris untuk editor atau supervisor VFX langsung di bidang ini.

---

## 10. Perbandingan Video

Muat file video untuk OLD dan NEW untuk membuka panel perbandingan penuh.

### Mode Perbandingan

#### Wipe
Slider vertikal membagi layar. Seret slider kiri/kanan untuk mengungkapkan OLD (kiri) atau NEW (kanan).

#### Side by Side (SBS)
OLD diputar di separuh kiri, NEW di separuh kanan secara bersamaan. Keduanya diputar sinkron.

#### Split
Seperti SBS tetapi setiap video mengisi separuhnya sepenuhnya (dipotong).

#### AB
Menampilkan satu video pada satu waktu layar penuh. Klik canvas untuk beralih antara A (OLD) dan B (NEW).

#### Diff
Menampilkan **gambar perbedaan piksel-per-piksel**: piksel yang identik tampak hitam, piksel yang berbeda tampak cerah.

#### Heat
Seperti Diff tetapi diberi kode warna berdasarkan besarnya:
- 🟢 Hijau: Perubahan kecil
- 🟡 Amber: Perubahan sedang
- 🔴 Merah: Perubahan besar

### Mode Chain

Ketika Chain diaktifkan, video OLD secara otomatis mencari **source-in klip OLD** saat Anda memilih event, sementara NEW mencari source-in klip NEW. Gunakan Chain saat meninjau event CHANGED di mana editorial berganti ke take yang berbeda.

---

## 11. Filter

### Filter Tipe

Klik tombol pil untuk hanya menampilkan tipe diff tertentu:

`ALL` `NEW` `EXTENDED` `CHANGED` `TRIMMED`

### Filter Risiko

`all` `high` `med` `low`

Klik **high** untuk melihat hanya event berisiko tinggi. Ini adalah titik awal yang direkomendasikan untuk tinjauan serah terima mana pun.

### Menggunakan Filter Bersama

Filter dikombinasikan: filter tipe DAN filter risiko keduanya berlaku. Untuk melihat semua perubahan berisiko tinggi yang bukan shot NEW, atur type=EXTENDED dan risk=high.

---

## 12. Alur Kerja Status & Catatan

### Pass Tinjauan yang Direkomendasikan

1. **Filter ke HIGH RISK** → tinjau semua item HIGH → tandai sebagai ✓ (ok) atau ? (query)
2. **Filter ke CHANGED** → periksa setiap penggantian take → catat jika VFX perlu diulang
3. **Filter ke NEW** → konfirmasi shot baru dengan koordinator → catat tanggal pull/delivery
4. **Filter ke EXTENDED** → periksa apakah ada shot VFX yang tumbuh melampaui anggaran
5. **Filter ke TRIMMED** → konfirmasi deliverable masih sesuai dalam jendela yang dipangkas

### Arti Status dalam Praktik

| Status | Kapan Digunakan |
|--------|----------------|
| **—** | Belum ditinjau |
| **✓ ok** | Ditinjau, tidak perlu tindakan, aman untuk dilanjutkan |
| **⊘ skip** | Diketahui / disengaja, lewati sesi ini |
| **? query** | Perlu bertanya kepada editor / koordinator sebelum bertindak |

---

## 13. Ekspor

Klik tombol amber **Export ▾** untuk membuka menu ekspor.

### Pull EDL

Menghasilkan CMX 3600 EDL yang hanya berisi event **NEW, CHANGED, dan EXTENDED**. Event dengan status **⊘ skip** dikecualikan.

### PDF Report

Membuka PDF siap cetak di tab browser baru dengan:
- **Header ringkasan**: Nama proyek, nama file OLD/NEW, tanggal, chip statistik
- **Kartu perubahan**: Satu kartu per event yang berubah, dikelompokkan berdasarkan tipe
- **Daftar Perubahan Audio**: Tabel terpisah untuk klip audio

### XLSX Change List

Mengekspor `.xlsx` workbook (4 lembar) dengan **gambar thumbnail yang disematkan**:

| Lembar | Isi |
|--------|-----|
| **Change List** | Semua event yang berubah dengan thumbnail 120×68 |
| **Audio Ref** | Semua event diurutkan berdasarkan RecIn, ditandai untuk audio |
| **Removed** | Klip yang ada di OLD tetapi tidak ada di NEW |
| **Summary** | Ikhtisar statistik: jumlah, durasi |

---

## 14. Pintasan Keyboard

| Tombol | Aksi |
|--------|------|
| `↓` atau `J` | Event berikutnya di tabel |
| `↑` atau `K` | Event sebelumnya di tabel |
| `Enter` | Siklus status event yang dipilih |
| `Escape` | Tutup panel inspektor |
| `Space` | Putar / Jeda |
| `←` | Mundur 1 frame |
| `→` | Maju 1 frame |

---

## 15. Tips & Contoh Alur Kerja

### Tips 1: Kerja dari Timeline ke Luar

Jangan mulai dari tabel — mulai dari timeline. Strip ringkasan menunjukkan di mana perubahan terkonsentrasi. Perbesar ke kluster padat, temukan batas shot, lalu klik event individual untuk menyelami inspektor.

### Tips 2: Gunakan Wipe Mode untuk Memeriksa Perubahan Framing

Event CHANGED dengan skor kecocokan tinggi (>75%) sering berarti editor menggunakan frame awal yang sedikit berbeda. Beralih ke Wipe mode dan cari ke frame pertama shot.

### Tips 3: Perhatikan Grafik Content Diff untuk Penggantian Diam-diam

Grafik content diff menangkap perubahan yang tidak bisa ditangkap EDL. Jika Anda melihat lonjakan di grafik di bawah wilayah yang tidak menampilkan bar berwarna di track NEW, nama klip/timecode identik tetapi kontennya berbeda secara visual.

### Tips 4: Filter HIGH + CHANGED untuk Masalah Paling Kompleks

Kombinasi risiko tinggi DAN tipe CHANGED adalah skenario paling menuntut: shot panjang yang ada diganti dengan take yang berbeda. Atur type=CHANGED dan risk=high untuk mengisolasi ini.

### Tips 5: Gunakan Catatan sebagai Memo Pengiriman

Ketik item tindakan Anda langsung ke bidang Note saat meninjau. Saat mengekspor XLSX, setiap catatan ada di spreadsheet — siap dibagikan dengan koordinator VFX atau editor musik.

### Tips 6: AB Mode untuk Perbandingan Take

Saat meninjau event CHANGED, masuk ke mode AB, pilih event, dan tekan canvas dengan cepat untuk beralih A/B. Karena Chain mode menyelaraskan kedua video ke awal shot, Anda beralih antara take OLD dan NEW dari adegan yang sama persis.

### Tips 7: Multi-Part EDL untuk Conform Besar

Jika sequence Anda memiliki lebih dari 1.500 event yang berubah, ekspor Pull EDL secara otomatis terbagi menjadi beberapa file (Bagian1, Bagian2, …).

---

*How to Use terakhir diperbarui: April 2026 · PostFlowX · CUT DIFF 2.0*
