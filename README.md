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
detectPlateRegion()          isolates the plate before OCR
  │  Sobel-X edges → binarise → horizontal dilation → vertical dilation
  │  → row-density bands → aspect-ratio filter (2:1 – 8.5:1, target 4.7:1)
  │  → best candidate padded and returned as {x,y,w,h}
  │  → null if no plausible plate found (full-image fallback)
     │
     ▼
preprocessImage()
  crop to detected region (or full image)
  scale crop to OCR_PLATE_WIDTH = 800 px  ← upscales small crops
  grayscale → Laplacian sharpen
  produces three data-URLs:
    grayUrl   – sharpened grayscale (LSTM prefers continuous tone)
    normalUrl – Otsu-binarised dark-on-light
    invertUrl – Otsu-binarised light-on-dark
     │
     ▼
Tesseract.js OEM 1 (LSTM only)
  Per PSM mode, three image variants are tried in order (gray → normal → invert)
  PSM 7 gray/normal/invert → early exit if valid plate found
  PSM 8/13 (+ PSM 6 for full-image fallback) only if earlier passes fail
  char whitelist: A-Z 0-9 (advisory; LSTM ignores it but cleanRegistration enforces it)
     │
     ▼
tryCandidate()
  cleanRegistration()   strip non-alphanumeric, uppercase (whole text)
  line split            also test each newline-separated line independently
                        (catches plates embedded in multi-line full-image OCR output)
  length gate           5–8 characters
     │
     ▼
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
| `js/app.js` | Rewrote `preprocessImage()` to crop to detected plate before scaling & binarising; now upscales small crops to give Tesseract more pixels; also produces a sharpened grayscale data-URL as primary input for LSTM |
| `js/app.js` | Updated `runOCR()` to try three image variants per PSM pass (grayscale → binarised → inverted); grayscale is first because LSTM neural net prefers continuous-tone images |
| `js/app.js` | Updated `tryCandidate()` to also split OCR output by newlines and test each line independently; fixes the case where full-image OCR embeds the plate in multi-line output |
| `js/app.js` | Added `silent` parameter to `initTesseract()` so worker restarts during an active OCR run no longer override the OCR status message with "OCR engine ready" |
| `js/app.js` | Changed `initTesseract()` call in OCR timeout handler to `initTesseract(true)` (silent) |
| `js/app.js` | Switched Tesseract worker from OEM 3 (combined LSTM+legacy) to OEM 1 (LSTM only) for faster recognition |
| `js/app.js` | Added early-exit to the PSM loop: stops as soon as any pass returns a plate within the valid length range, typically reducing to 1 recognize() call instead of many |
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
| `OCR_TIME_BUDGET_MS` | 5000 | **Soft** budget (ms). If already exceeded _and_ a valid plate has been found, further PSM passes are skipped. Does not abort an in-flight recognise() call. |
| `OCR_PASS_TIMEOUT_MS` | 20000 | **Hard** per-pass limit (ms). If a single recognise() call takes longer than this the worker is restarted; any results from earlier passes are still shown. |

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
* `[OCR] PSM 7 gray: "PY61AUU"` – raw Tesseract output for each image variant
  and PSM mode (variants: `gray`, `normal`, `invert`).
* `[OCR] PSM 7 pass timed out — restarting worker; using best result so far` –
  a single pass exceeded `OCR_PASS_TIMEOUT_MS`; earlier passes' results are
  still used.

A green dashed rectangle is also drawn on the preview image showing exactly
which region was passed to OCR.
