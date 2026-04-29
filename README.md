# Car-Parking
Workplace Car Parking Validation App

## OCR Pipeline

The app recognises number plates entirely in the browser using
[Tesseract.js](https://github.com/naptha/tesseract.js).

### Pipeline stages

```
Photo / upload
     │
     ▼
detectPlateRegion()          ← NEW: isolates the plate before OCR
  │  Sobel-X edges → binarise → horizontal dilation → vertical dilation
  │  → row-density bands → aspect-ratio filter (2:1 – 8.5:1, target 4.7:1)
  │  → best candidate padded and returned as {x,y,w,h}
  │  → null if no plausible plate found (full-image fallback)
     │
     ▼
preprocessImage()
  crop to detected region (or full image)
  scale crop to OCR_PLATE_WIDTH = 800 px  ← upscales small crops
  greyscale → Laplacian sharpen → Otsu binarise
  produces normal + inverted data-URLs
     │
     ▼
Tesseract.js OEM 1 (LSTM only) – faster than combined LSTM+legacy
  PSM 7 normal → early exit if valid plate found
  PSM 7 inverted → early exit if valid plate found
  PSM 8/13 (+ PSM 6 for full-image fallback) only if earlier passes fail
  char whitelist: A-Z 0-9
     │
     ▼
cleanRegistration()   strip non-alphanumeric, uppercase
length gate           5–8 characters
correctOcrForUKPlate() positional O↔0 / I↔1 / etc. (7-char plates only)
findFuzzyMatch()      Levenshtein ≤ 1 against stored registrations
     │
     ▼
Display result + green dashed overlay box on preview image
```

### Root cause of the original 0 % accuracy

OCR was running on the **full camera image** (buildings, grass, background
text) rather than a tightly bounded plate region.  Tesseract read background
detail as characters, producing strings such as `0SELCLFALKSSSAYSLFICAAEA`
instead of `PY61AUU`.

### Changes made (PR)

| Area | Change |
|---|---|
| `js/app.js` constants | Replaced `OCR_TARGET_WIDTH` (1600 px, full image) with `OCR_PLATE_WIDTH` (800 px, crop), `OCR_FULL_WIDTH` (1200 px, fallback cap), `PLATE_DETECT_WIDTH` (640 px, detector working size) |
| `js/app.js` | Added `loadImage()` helper to DRY up image loading |
| `js/app.js` | Added `detectPlateRegion()` – Sobel-X + morphological dilation + aspect-ratio scoring |
| `js/app.js` | Rewrote `preprocessImage()` to crop to detected plate before scaling & binarising; now upscales small crops to give Tesseract more pixels |
| `js/app.js` | Updated `runOCR()` to use only PSM 7/8/13 after a confirmed crop (was 4 modes × full image = 8 passes) |
| `js/app.js` | Switched Tesseract worker from OEM 3 (combined LSTM+legacy) to OEM 1 (LSTM only) for faster recognition |
| `js/app.js` | Added early-exit to the PSM loop: stops as soon as any pass returns a plate within the valid length range, typically reducing to 1 recognize() call instead of 6 |
| `js/app.js` | Added `drawPlateOverlay()` – draws a green dashed box on the preview showing the detected plate region |
| `index.html` | Added `<canvas id="plate-overlay">` inside the preview box |
| `css/style.css` | Added `.plate-overlay` absolute positioning |

### Tuning parameters

All tuning constants are defined at the top of `js/app.js` for easy adjustment.

| Constant | Default | Purpose |
|---|---|---|
| `PLATE_DETECT_WIDTH` | 640 | Working resolution for detector (px). Increase for higher precision on tiny plates, decrease for speed. |
| `OCR_PLATE_WIDTH` | 800 | Width the plate crop is scaled to before OCR. 600–1000 px is the practical range. |
| `OCR_FULL_WIDTH` | 1200 | Cap on full-image width when no plate is detected. |
| `SOBEL_THRESH` | 50 | Edge binarisation threshold. Lower = more sensitive to faint edges; raise to reduce false positives. |
| `ROW_DENSITY_THRESH` | 0.15 | Minimum fraction of a row's pixels that must be active for it to count as a plate row. |
| `PLATE_MIN_WIDTH_PC` | 0.15 | Plate must span ≥ 15 % of image width to be a candidate. |
| `PLATE_MIN_AR` / `PLATE_MAX_AR` | 2.0 / 8.5 | Accepted aspect-ratio range. UK standard plate ≈ 4.7 : 1. |
| `PLATE_TARGET_AR` | 4.7 | Ideal aspect ratio used to score candidates. |
| `AR_SCORE_WEIGHT` | 3 | How much the aspect-ratio score is weighted vs. the area score in candidate ranking. |

### UK number plate format assumptions

Modern UK registrations follow **LL00 LLL** (2 area letters, 2 age digits, 3
random letters, e.g. `PY61 AUU`).  The positional correction in
`correctOcrForUKPlate()` uses this layout to swap commonly misread characters
at known digit/letter positions.  The function is a no-op for any plate that
is not exactly 7 characters long, so it does not corrupt non-standard plates.

### Debugging

Open the browser console after uploading a photo.  The pipeline logs:

* `[OCR] Plate detected at {x, y, w, h}` – detection coordinates in the
  original image.
* `[OCR] No plate region detected — running OCR on full image` – fallback
  active.
* `[OCR] PSM 7 normal: "PY61AUU"` – raw Tesseract output for each pass.

A green dashed rectangle is also drawn on the preview image showing exactly
which region was passed to OCR.
