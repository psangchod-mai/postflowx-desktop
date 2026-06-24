# CUT DIFF 2.0 — Kumpletong Gabay

**PostFlowX · Editorial Diff at Paghahambing**

---

## Talaan ng Nilalaman

1. [Ano ang Cut Diff 2.0?](#1-ano-ang-cut-diff-20)
2. [Pag-load ng mga Timeline](#2-pag-load-ng-mga-timeline)
3. [Pagpapatakbo ng Diff](#3-pagpapatakbo-ng-diff)
4. [Pag-unawa sa mga Uri ng Diff](#4-pag-unawa-sa-mga-uri-ng-diff)
5. [Pagmamarka ng Panganib](#5-pagmamarka-ng-panganib)
6. [Pagbabasa ng Timeline](#6-pagbabasa-ng-timeline)
7. [Mga Shot Cut at Paano Makita Ang mga Ito](#7-mga-shot-cut-at-paano-makita-ang-mga-ito)
8. [Ang Diff Table](#8-ang-diff-table)
9. [Ang Inspector Panel](#9-ang-inspector-panel)
10. [Paghahambing ng Video](#10-paghahambing-ng-video)
11. [Mga Filter](#11-mga-filter)
12. [Workflow ng Status at Tala](#12-workflow-ng-status-at-tala)
13. [Pag-export](#13-pag-export)
14. [Mga Shortcut sa Keyboard](#14-mga-shortcut-sa-keyboard)
15. [Mga Tip at Halimbawa ng Workflow](#15-mga-tip-at-halimbawa-ng-workflow)

---

## 1. Ano ang Cut Diff 2.0?

Ikukumpara ng Cut Diff 2.0 ang dalawang bersyon ng na-edit na timeline — isang **LUMANG cut (OLD)** at isang **BAGONG cut (NEW)** — at ipapakita kung ano mismo ang nagbago sa pagitan ng mga ito. Sinasagot nito ang mga tanong na:

- Aling mga clip ang idinagdag, tinanggal, o pinalitan?
- Aling mga shot ang pinalawak o pinaikli?
- Magkano na screen time ang idinagdag o tinanggal?
- Aling mga pagbabago ang may mataas na panganib at nangangailangan ng agarang atensyon mula sa VFX/audio/musika?

Idinisenyo para sa **editorial turnover**: mga koordinador ng VFX, katulong na mga editor, mga editor ng tunog, at mga superbisor ng musika na kailangang maunawaan nang mabilis ang isang picture lock revision.

**Mga sinusuportahang format ng file**: EDL (CMX 3600), FCPXML, ALE, XML timeline export mula sa DaVinci Resolve, Avid, Premiere, at Final Cut Pro X.

---

## 2. Pag-load ng mga Timeline

### Mga Drop Zone

Sa itaas ng tab ay makikita mo ang dalawang drop zone:

```
┌────────────────────┐   ┌────────────────────┐
│  I-drop ang LUMANG │   │  I-drop ang BAGONG  │
│  Timeline          │   │  Timeline           │
│  o i-click Browse  │   │  o i-click Browse   │
└────────────────────┘   └────────────────────┘
```

- **Kaliwang zone = OLD** — ang nakaraang bersyon (iyong sanggunian/baseline)
- **Kanang zone = NEW** — ang na-update na bersyon na natanggap mo mula sa editorial

I-drag-and-drop ang isang file sa bawat zone, o i-click ang **Browse** para pumili ng file. Kapag na-load ang isang file, lalabas ang pangalan ng file sa zone at magbabago ang zone upang ma-highlight.

### Alin ang OLD at alin ang NEW?

Laging i-load ang **mas lumang** bersyon bilang OLD at ang **mas bagong** bersyon bilang NEW. Mahalaga ang direksyon ng diff: ang isang event ay minarkahang EXTENDED kapag ang clip ng NEW ay mas mahaba kaysa sa clip ng OLD. Kung ma-load nang baligtad, ang lahat ng label na EXTENDED/TRIMMED ay mabababaligtad.

### Pag-load ng mga Video File (opsyonal ngunit inirerekomenda)

Sa ibaba ng mga drop zone ay ang panel ng **Video Compare**. Maaari mong opsyonal na i-drop o i-browse ang mga aktwal na video file para sa OLD at NEW. Pinapagana nito ang:

- Mga frame-accurate na filmstrip thumbnail sa timeline
- Side-by-side / wipe / difference video comparison
- Pixel-level content diff graph sa ilalim ng timeline

Ang mga video file ay iniimbak sa IndexedDB ng browser kaya naalala ang mga ito sa pagitan ng mga session.

---

## 3. Pagpapatakbo ng Diff

I-click ang button na **Analyze** sa header. Pinapagana nito ang diff engine na:

1. Nini-parse ang lahat ng clip mula sa parehong timeline
2. Tinutugma ang bawat clip ng NEW sa pinakamainam na katapat sa OLD ayon sa **pagkakakilanlan ng clip** (pangalan ng clip + reel)
3. Inuuri ang bawat tugma sa isang uri ng diff (NEW, EXTENDED, CHANGED, TRIMMED)
4. Kinakalkula ang **risk score** para sa bawat pagbabago
5. Nirererender ang KPI bar, timeline, at talahanayan

Ang diff ay ganap na tumatakbo sa browser — walang pag-upload, walang server.

### KPI Bar

Pagkatapos suriin, lalabas ang isang hilera ng mga metric card:

| Card | Ano ang Ipinapakita |
|------|---------------------|
| **NEW** | Mga clip na lumitaw sa NEW ngunit walang katugmang clip sa OLD |
| **EXTENDED** | Mga clip na tumaas ang tagal sa pagitan ng OLD at NEW |
| **CHANGED** | Parehong pangalan ng clip, iba ang materyal o take |
| **TRIMMED** | Mga clip na bumaba ang tagal |
| **HIGH RISK** | Mga event na nangangailangan ng agarang atensyon (tingnan ang §5) |
| **+DUR** | Kabuuang screen time na idinagdag (frame ng NEW + EXTENDED) |
| **−DUR** | Kabuuang screen time na tinanggal (frame ng TRIMMED) |
| **% Changed** | Kung anong bahagi ng cut ang nagbago |

---

## 4. Pag-unawa sa mga Uri ng Diff

Ikukumpara ng engine ang bawat clip ng NEW laban sa mga clip ng OLD na may **parehong pangalan ng clip at reel**. Kapag nahanap ang isang tugma, ang tagal at punto ng source-in ay ikukumpara sa loob ng maliit na tolerance (±2 frame sa tagal, ±4 frame sa source-in).

### NEW
```
OLD: [wala]
NEW: [████████ CLIP_A ████████]
```
Ang clip ay nasa NEW ngunit **walang clip ng parehong pagkakakilanlan** kahit saan sa OLD. Ang lahat ng event ng NEW ay awtomatikong **MATAAS NA PANGANIB**.

### EXTENDED
```
OLD: [████████ CLIP_B ████████]         (200 frame)
NEW: [█████████████ CLIP_B █████████]   (260 frame + 60 frame na idinagdag)
```
Parehong clip, ngunit ang NEW cut ay **mas mahaba**. Para sa VFX karaniwang nangangahulugang kailangang palawakin ang window ng trabaho ng VFX.

### TRIMMED
```
OLD: [█████████████ CLIP_C █████████]   (180 frame)
NEW: [████ CLIP_C ████]                  (80 frame — 100 frame na tinanggal)
```
Parehong clip, ngunit ang NEW cut ay **mas maikli**. Para sa VFX, ang trabaho ay maaaring magsimula na sa ibang oras o matapos na mas maaga kaysa sa badyet.

### CHANGED
```
OLD: [████ CLIP_D (srcIn=00:42:15:00) ████]
NEW: [████ CLIP_D (srcIn=01:12:30:08) ████]   parehong pangalan, ganap na ibang pinagmulan
```
Parehong pangalan ng clip, ngunit ang source timecode (srcIn) ay naiiba ng higit sa tolerance. Nagpapahiwatig ito ng: ibang take, retime o regrade na bersyon, o pinalitang clip na may parehong pangalan.

### UNCHANGED
```
OLD: [████ CLIP_E ████]  (srcIn=00:10:00:00, dur=120fr)
NEW: [████ CLIP_E ████]  (srcIn=00:10:00:00, dur=120fr) — magkapareho
```
Ang clip ay pareho sa parehong cut sa loob ng tolerance. Bilang default, ang mga event ng UNCHANGED ay **nakatago mula sa talahanayan**.

---

## 5. Pagmamarka ng Panganib

Ang bawat diff event ay may antas ng panganib batay sa kung ano ang ibig sabihin nito para sa downstream na trabaho.

### Mga Antas ng Panganib

| Antas | Kulay | Patakaran |
|-------|-------|-----------|
| **MATAAS** | 🔴 Pula | Anumang event na NEW **o** anumang event na tumatagal nang higit sa 240 frame (~10 seg sa 24fps) |
| **KATAMTAMAN** | 🟡 Amber | Tagal ng event na 48–240 frame (~2–10 segundo) |
| **MABABA** | 🟢 Berde | Tagal ng event na wala pang 48 frame (~2 segundo) |

### Match Score (% ng Kumpiyansa)

Para sa mga event ng EXTENDED, CHANGED, at TRIMMED, ang engine ay nag-uulat din ng **match confidence** na 0–100%:

- **100%**: Perpektong tugma
- **75–99%**: Maliit na trim o maliit na pagsasaayos ng pinagmulan — mataas na kumpiyansa
- **50–74%**: Katamtamang pagkakaiba — sulit suriin muli
- **< 50%**: Malaking pagkakaiba — maaaring maling tugma

Ang score ay kinakalkula bilang:
`(kumpiyansa sa tagal × 60%) + (kumpiyansa sa source-in × 40%)`

---

## 6. Pagbabasa ng Timeline

Ang timeline ang pinaka-makapangyarihang bahagi ng Cut Diff 2.0. Ipinapakita nito ang **parehong** OLD at NEW cut nang magkakatabi bilang mga pahalang na track.

### Layout ng Timeline (mula itaas pababa)

```
┌─────────────────────────────────────────────────────────────┐
│ RULER  │ 00:00   00:30   01:00   01:30   02:00              │ ← Timecode ruler
├────────────────────────────────────────────────────────────┤
│  OLD ░░░░▓▓▓▓▓░░▓▓▓▓░░░░░░▓▓░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░░  │ ← Track ng OLD
│ ─────────────────── DIFF ──────────────────────────────────── │ ← Separator ng Diff
│  NEW ░░░▓▓▓▓░░░░░░░▓▓▓▓▓▓░░░▓░░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░  │ ← Track ng NEW
│ ▓▓▓░░░░▓▓▓░▓░▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ ← Summary Strip
├────────────────────────────────────────────────────────────┤
│ Content diff ░░▓░░░░░░▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ ← Pixel diff graph
└─────────────────────────────────────────────────────────────┘
```

### Track ng NEW at mga Kulay na Bar ng Diff

Ipinapakita ng track ng NEW ang bawat clip na may **kulay na bar sa ibaba** na nagpapahiwatig ng status ng diff nito:

| Kulay | Uri ng Diff | Kahulugan |
|-------|-------------|-----------|
| 🔵 Maliwanag na cyan | NEW | Hindi pa nakikita noon — wala sa OLD |
| 🟢 Berde | EXTENDED | Lumaki ang clip na ito kumpara sa OLD |
| 🟡 Amber | CHANGED | Parehong pangalan, ibang pinagmulan/take |
| 🟣 Lila | TRIMMED | Lumit ang clip na ito kumpara sa OLD |
| ⬛ Napakadilim | UNCHANGED | Magkapareho sa OLD |

Ang **2px na pulang guhit sa itaas** ng clip ay nangangahulugang MATAAS NA PANGANIB.

### Content Diff Graph

Ang bar graph sa ibaba ng summary strip ay nagpapakita ng **pixel-level frame similarity** sa pagitan ng OLD at NEW.

| Kulay | Kahulugan |
|-------|-----------|
| 🟢 Berdeng bar | Halos magkapareho ang hitsura ng mga frame |
| 🟡 Amber na bar | Katamtamang visual na pagkakaiba |
| 🔴 Pulang bar | Napaka-iba ang hitsura ng mga frame |

---

## 7. Mga Shot Cut at Paano Makita Ang mga Ito

### Paano Makita ang mga Shot Cut sa Timeline

**Paraan 1: Tingnan ang mga punto ng simula/katapusan ng mga clip sa track ng NEW**

Kapag ang mga kulay na diff bar sa mga katabing clip ay may iba't ibang uri, may makabuluhang pagbabago sa punto ng edit.

**Paraan 2: Mag-zoom sa isang nagbagong seksyon**

Gamitin ang **scroll wheel para mag-zoom** sa timeline. Habang nagzo-zoom, nagiging mas detalyado ang mga marka sa ruler at nagiging makikita ang mga indibidwal na shot.

**Paraan 3: Abangan ang mga kumpol sa summary strip**

Ipinapakita ng summary strip ang buong cut na nakakompress sa isang bar. Ang isang kumpol ng mga kulay (cyan/amber/berde) ay nangangahulugang isang siksik na zone ng rebisyon.

**Paraan 4: Direktang ikumpara ang mga gilid ng clip ng OLD at NEW**

Pumili ng TRIMMED event sa talahanayan. Ipinapakita ng inspektor ang mga halaga ng `RecIn`/`RecOut` para sa OLD at NEW. Ang pagkakaiba ay kung magkano ang naglipat ng cut point.

---

## 8. Ang Diff Table

Inililista ng talahanayan ang bawat nagbagong event bilang isang hilera.

### Gabay sa Kolum

| Kolum | Paglalarawan |
|-------|-------------|
| **●** | Risk pip — pula (mataas), amber (katamtaman), berde (mababa) |
| **Type** | Badge na NEW / EXT / CHG / TRM / UNC |
| **Reel** | Pangalan ng reel o bin mula sa EDL/XML |
| **Clip** | Pangalan ng clip |
| **SrcIn** | Source timecode in |
| **Dur** | Tagal sa mga frame |
| **Match%** | Confidence score (bar + %) — blangko para sa mga event ng NEW |
| **Status** | Ang iyong review status: — / ✓ / ⊘ / ? (i-click para mag-cycle) |
| **Note** | Libreng text field (makikita sa inspektor) |

### Pagpili ng Hilera

I-click ang anumang hilera para:
1. **Buksan ang inspektor** (kanang panel) na may kumpletong detalye ng event
2. **I-zoom ang timeline** para i-sentro ang event na iyon
3. **Hanapin ang video** sa timecode ng `RecIn` ng event (kung na-load ang video)

---

## 9. Ang Inspector Panel

I-click ang anumang hilera para buksan ang inspektor sa kanang bahagi. Ipinapakita nito ang kumpletong breakdown ng napiling pagbabago.

### Mga Field

```
Event 3 / 47                 ← bilang ng event mula sa kabuuan
Type:    EXTENDED             ← diff classification
Reel:    A001                 ← pangalan ng reel
Clip:    105_08_06/01_AB      ← pangalan ng clip
SrcIn:   10:42:15:00          ← source start sa NEW
SrcOut:  10:42:28:10          ← source end sa NEW
RecIn:   01:02:45:00          ← record (program) start
RecOut:  01:02:58:10          ← record (program) end
Duration: 318 frame
FPS:      24
```

### Info ng Tugma (para sa EXTENDED / TRIMMED / CHANGED)

```
Match Score:  ████████░░  78%  ← confidence bar
Reason:       Duration +48fr (+2.0s extended)
Old Clip:     105_08_06/01_AB  ← parehong clip sa OLD
Old SrcIn:    10:42:15:00      ← source start sa OLD
Old RecIn:    01:02:45:00      ← record start sa OLD
```

### Status at mga Tala

**Status** (i-click o pindutin ang Enter para mag-cycle):
- **—** (wala): Hindi pa nasuri
- **✓** (ok): Nakumpirma, walang kinakailangang aksyon
- **⊘** (laktaw): Kilalang isyu, laktawan sa pass na ito
- **?** (tanong): Kailangan ng follow-up o talakayan

Ang mga tala ay lumalabas sa parehong PDF at XLSX na export.

---

## 10. Paghahambing ng Video

Mag-load ng mga video file para sa OLD at NEW para ma-unlock ang buong comparison panel.

### Mga Mode ng Paghahambing

#### Wipe
Isang patayong slider ang nagtatahak ng screen. I-drag ang slider kaliwa/kanan para ihayag ang OLD (kaliwa) o NEW (kanan).

#### Side by Side (SBS)
Ang OLD ay nagpe-play sa kaliwang kalahati, ang NEW sa kanang kalahati nang sabay-sabay. Parehong nagpe-play nang naka-sync.

#### Split
Tulad ng SBS ngunit ang bawat video ay nagpupuno ng kalahati nito nang buo (naputol).

#### AB
Nagpapakita ng isang video nang sabay sa buong screen. I-click ang canvas para mag-toggle sa pagitan ng A (OLD) at B (NEW).

#### Diff
Nagpapakita ng **pixel-by-pixel na larawan ng pagkakaiba**: ang mga magkaparehong pixel ay mukhang itim, ang mga nagkakaibang pixel ay mukhang maliwanag.

#### Heat
Tulad ng Diff ngunit may color-coded ayon sa magnitude:
- 🟢 Berde: Maliit na pagbabago
- 🟡 Amber: Katamtamang pagbabago
- 🔴 Pula: Malaking pagbabago

### Chain Mode

Kapag naka-enable ang Chain, awtomatikong naghahanap ang OLD video sa **source-in ng clip ng OLD** kapag pumili ka ng event, habang naghahanap ang NEW sa source-in ng clip ng NEW. Gamitin ang Chain kapag sinusuri ang mga event ng CHANGED.

---

## 11. Mga Filter

### Type Filter

I-click ang mga pill button para ipakita lamang ang isang partikular na uri ng diff:

`ALL` `NEW` `EXTENDED` `CHANGED` `TRIMMED`

### Risk Filter

`all` `high` `med` `low`

I-click ang **high** para makita lamang ang mga event na may mataas na panganib. Ito ang inirerekomendang panimulang punto para sa anumang turnover review.

### Paggamit ng mga Filter Nang Magkasama

Pinagsama ang mga filter: ang type filter AT risk filter ay parehong naaangkop. Para makita ang lahat ng high-risk na pagbabago na hindi NEW shots, itakda ang type=EXTENDED at risk=high.

---

## 12. Workflow ng Status at Tala

### Inirerekomendang Review Pass

1. **I-filter sa HIGH RISK** → suriin ang lahat ng HIGH na item → markahan bilang ✓ (ok) o ? (tanong)
2. **I-filter sa CHANGED** → suriin ang bawat pagpapalit ng take → itala kung kailangan ng VFX na gawin muli
3. **I-filter sa NEW** → kumpirmahin ang mga bagong shot sa koordinador → itala ang mga petsa ng pull/delivery
4. **I-filter sa EXTENDED** → suriin kung lumago ang anumang VFX shot nang higit sa badyet
5. **I-filter sa TRIMMED** → kumpirmahin na ang mga deliverable ay nababagay pa rin sa loob ng trimmed window

### Mga Kahulugan ng Status sa Pagsasagawa

| Status | Kailan Gamitin |
|--------|---------------|
| **—** | Hindi pa nasuri |
| **✓ ok** | Nasuri, walang kinakailangang aksyon, ligtas na magpatuloy |
| **⊘ laktaw** | Kilala / sadya, laktawan sa session na ito |
| **? tanong** | Kailangan magtanong sa editor / koordinador bago kumilos |

---

## 13. Pag-export

I-click ang amber na button na **Export ▾** para buksan ang export menu.

### Pull EDL

Gumagawa ng CMX 3600 EDL na naglalaman lamang ng mga event na **NEW, CHANGED, at EXTENDED**. Ang mga event na may status na **⊘ laktaw** ay hindi kasama.

### PDF Report

Nagbubukas ng print-ready na PDF sa isang bagong browser tab na may:
- **Summary header**: Pangalan ng proyekto, mga pangalan ng file ng OLD/NEW, petsa, mga stat chip
- **Mga card ng pagbabago**: Isang card bawat nagbagong event, nakagrupo ayon sa uri
- **Audio Change List**: Isang hiwalay na talahanayan para sa mga audio track clip

### XLSX Change List

Nag-e-export ng `.xlsx` workbook (4 sheet) na may **naka-embed na mga thumbnail na larawan**:

| Sheet | Nilalaman |
|-------|-----------|
| **Change List** | Lahat ng nagbagong event na may thumbnail na 120×68 |
| **Audio Ref** | Lahat ng event na nakaayos ayon sa RecIn, na may flag para sa audio |
| **Removed** | Mga clip na nasa OLD ngunit wala sa NEW |
| **Summary** | Pangkalahatang-ideya ng mga istatistika: bilang, mga tagal |

---

## 14. Mga Shortcut sa Keyboard

| Key | Aksyon |
|-----|--------|
| `↓` o `J` | Susunod na event sa talahanayan |
| `↑` o `K` | Nakaraang event sa talahanayan |
| `Enter` | Mag-cycle ng status ng napiling event |
| `Escape` | Isara ang inspector panel |
| `Space` | Play / Pause |
| `←` | Umatras ng 1 frame |
| `→` | Sumulong ng 1 frame |

---

## 15. Mga Tip at Halimbawa ng Workflow

### Tip 1: Magtrabaho mula sa Timeline Palabas

Huwag magsimula sa talahanayan — magsimula sa timeline. Ipinapakita ng summary strip kung saan nagkakakumpol ang mga pagbabago. Mag-zoom sa isang siksik na kumpol, hanapin ang mga hangganan ng shot, pagkatapos ay i-click ang mga indibidwal na event para mag-drill down sa inspektor.

### Tip 2: Gamitin ang Wipe Mode para Suriin ang mga Pagbabago sa Framing

Ang isang CHANGED event na may mataas na match score (>75%) ay kadalasang nangangahulugang gumamit ang editor ng bahagyang ibang simula ng frame. Lumipat sa Wipe mode at mag-scrub sa unang frame ng shot.

### Tip 3: Abangan ang Content Diff Graph para sa mga Tahimik na Pagpapalit

Ang content diff graph ay nakakakuha ng mga pagbabago na hindi kayang makuha ng EDL. Kung makakita ka ng spike sa graph sa ilalim ng isang rehiyon na walang kulay na bar sa track ng NEW, ang mga pangalan ng clip/timecode ay magkapareho ngunit ang nilalaman ay visual na naiiba.

### Tip 4: I-filter ang HIGH + CHANGED para sa Pinaka-kumplikadong mga Isyu

Ang kombinasyon ng mataas na panganib AT uri ng CHANGED ang pinaka-demanding na senaryo: isang mahabang umiiral na shot ay pinalitan ng ibang take. Itakda ang type=CHANGED at risk=high para ihiwalay ang mga ito.

### Tip 5: Gamitin ang mga Tala bilang mga Delivery Memo

I-type ang iyong action item direkta sa Note field habang sinusuri. Kapag nag-export ng XLSX, ang bawat tala ay nasa spreadsheet — handa nang ibahagi sa koordinador ng VFX o editor ng musika.

### Tip 6: AB Mode para sa Paghahambing ng Take

Kapag sinusuri ang mga event ng CHANGED, pumasok sa AB mode, piliin ang event, at mabilis na pindutin ang canvas para mag-toggle ng A/B. Dahil ina-align ng Chain mode ang parehong video sa simula ng shot, nagto-toggle ka sa pagitan ng take ng OLD at NEW ng eksaktong parehong eksena.

### Tip 7: Multi-Part EDL para sa Malalaking Conform

Kung ang iyong sequence ay may higit sa 1,500 nagbagong event, ang Pull EDL export ay awtomatikong mahahati sa maraming file (Bahagi1, Bahagi2, …).

---

*Huling na-update ang tutorial: Abril 2026 · PostFlowX · CUT DIFF 2.0*
