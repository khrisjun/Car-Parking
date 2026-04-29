/**
 * app.js – Car Parking Validation App
 *
 * Handles:
 *  1. Image capture (camera or file upload)
 *  2. OCR via Tesseract.js to extract registration characters
 *  3. Validation against stored registrations
 *  4. Display of pass/fail result
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY        = 'carpark_registrations';
const MIN_PLATE_LENGTH   = 5;    // shortest plausible registration (e.g. "A1BCR")
const MAX_PLATE_LENGTH   = 8;    // longest plausible registration (e.g. "AB12 CDE")
const OCR_PLATE_WIDTH    = 800;  // target width when scaling a detected plate crop for OCR
const OCR_FULL_WIDTH     = 1200; // max width when falling back to full-image OCR (downscale only)
const PLATE_DETECT_WIDTH = 640;  // working resolution for the plate-detection algorithm

// ─── Plate-detection tuning parameters ───────────────────────────────────────
// These constants control detectPlateRegion() and can be adjusted to improve
// detection accuracy for different camera angles or lighting conditions.
const SOBEL_THRESH       = 50;   // edge binarisation threshold; lower → more sensitive
const ROW_DENSITY_THRESH = 0.15; // min fraction of a row's pixels that must be active
const PLATE_TARGET_AR    = 4.7;  // ideal aspect ratio: UK standard plate 520 × 111 mm
const PLATE_MIN_AR       = 2.0;  // minimum accepted aspect ratio (covers motorcycle plates)
const PLATE_MAX_AR       = 8.5;  // maximum accepted aspect ratio
const PLATE_MIN_WIDTH_PC = 0.15; // plate must span ≥ this fraction of image width
const AR_SCORE_WEIGHT    = 3;    // aspect-ratio score weight vs. area score (higher = prefer AR)

// ─── DOM References ───────────────────────────────────────────────────────────
const cameraInput    = document.getElementById('camera-input');
const uploadInput    = document.getElementById('upload-input');
const previewImg     = document.getElementById('preview-img');
const previewPlaceholder = document.getElementById('preview-placeholder');
const plateOverlay   = document.getElementById('plate-overlay');
const ocrStatus      = document.getElementById('ocr-status');
const regInput       = document.getElementById('reg-input');
const validateBtn    = document.getElementById('validate-btn');
const resultCard     = document.getElementById('result-card');
const resultIcon     = document.getElementById('result-icon');
const resultBadge    = document.getElementById('result-badge');
const resultMessage  = document.getElementById('result-message');
const resultSub      = document.getElementById('result-sub');
const tryAgainBtn    = document.getElementById('try-again-btn');

// ─── State ────────────────────────────────────────────────────────────────────
let tesseractWorker  = null;
let workerReady      = false;

// ─── Initialise ───────────────────────────────────────────────────────────────
(async function init() {
  seedDefaultRegistrations();
  await initTesseract();
})();

/** Seed localStorage with defaults if empty */
function seedDefaultRegistrations() {
  if (!localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_REGISTRATIONS));
  }
}

/** Initialise Tesseract worker (eng, alphanumeric chars only) */
async function initTesseract() {
  setOcrStatus('Loading OCR engine…', true);
  try {
    // OEM 1 = LSTM neural net only — substantially faster than the combined
    // LSTM+legacy engine (OEM 3) while retaining excellent accuracy for
    // high-contrast plate crops.  Positional correction and fuzzy matching
    // downstream handle the rare character confusions (W/H, O/0, etc.).
    tesseractWorker = await Tesseract.createWorker('eng', 1 /* OEM_LSTM_ONLY */, {
      logger: () => {} // suppress verbose logs
    });
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      preserve_interword_spaces: '0',
    });
    workerReady = true;
    setOcrStatus('OCR engine ready', false);
    setTimeout(() => setOcrStatus('', false), 2000);
  } catch (err) {
    console.error('Tesseract init error:', err);
    setOcrStatus('OCR engine failed to load. You can still type the registration manually.', false);
  }
}

// ─── Image capture / upload ───────────────────────────────────────────────────

/** Trigger camera */
document.getElementById('btn-camera').addEventListener('click', () => {
  cameraInput.click();
});

/** Trigger file upload */
document.getElementById('btn-upload').addEventListener('click', () => {
  uploadInput.click();
});

/** Handle image selected from camera */
cameraInput.addEventListener('change', (e) => handleFileSelected(e.target.files[0]));

/** Handle image selected from file picker */
uploadInput.addEventListener('change', (e) => handleFileSelected(e.target.files[0]));

/** Process a selected image file */
async function handleFileSelected(file) {
  if (!file) return;

  // Reset UI
  resetResult();
  regInput.value = '';

  // Show preview
  const objectUrl = URL.createObjectURL(file);
  previewImg.src = objectUrl;
  previewImg.style.display = 'block';
  previewPlaceholder.style.display = 'none';

  // Run OCR
  await runOCR(objectUrl);
}

// ─── OCR ──────────────────────────────────────────────────────────────────────

/** Load an Image element from a URL; resolves with the element once ready. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src     = src;
  });
}

/**
 * Detect the most likely number plate region in an image.
 *
 * Returns a Promise<{x,y,w,h}|null> in original-image pixel coordinates.
 * Returns null when no plausible candidate is found; the caller then falls
 * back to running OCR on the full image.
 *
 * Algorithm (all processing at PLATE_DETECT_WIDTH for speed):
 *   1. Downscale to PLATE_DETECT_WIDTH.
 *   2. Convert to greyscale.
 *   3. Compute Sobel-X magnitude (highlights vertical character strokes,
 *      which are the dominant edge feature on a number plate).
 *   4. Binarise at SOBEL_THRESH.
 *   5. Dilate horizontally (≈2.5 % of working width) to merge per-character
 *      blobs into a single contiguous stripe.
 *   6. Dilate vertically  (≈1.5 % of working height) to merge character rows.
 *   7. Compute per-row edge density; group consecutive dense rows into bands.
 *   8. For each band find the x-extent of active pixels.
 *   9. Filter by aspect ratio PLATE_MIN_AR → PLATE_MAX_AR and minimum width
 *      PLATE_MIN_WIDTH_PC.  UK standard plates are ≈ 4.7 : 1 (520 × 111 mm).
 *  10. Score by closeness to the standard UK plate aspect ratio and region area.
 *  11. Pad the winning candidate (5 % horizontal, 20 % vertical) to avoid
 *      clipping descenders, then scale back to original coordinates.
 */
async function detectPlateRegion(imageSource) {
  let img;
  try { img = await loadImage(imageSource); } catch { return null; }

  const origW = img.naturalWidth  || img.width;
  const origH = img.naturalHeight || img.height;
  const scale = Math.min(1, PLATE_DETECT_WIDTH / origW);
  const dw    = Math.round(origW * scale);
  const dh    = Math.round(origH * scale);

  const c   = document.createElement('canvas');
  c.width   = dw;
  c.height  = dh;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, dw, dh);
  const { data } = ctx.getImageData(0, 0, dw, dh);

  // ── Greyscale – ITU-R BT.601 luma weights scaled to integer arithmetic ──────
  const gray = new Uint8Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) {
    gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
  }

  // ── Sobel-X magnitude (vertical character strokes) ────────────────────────
  const sobel = new Uint8Array(dw * dh);
  for (let y = 1; y < dh - 1; y++) {
    for (let x = 1; x < dw - 1; x++) {
      const gx =
        -gray[(y - 1) * dw + (x - 1)] + gray[(y - 1) * dw + (x + 1)] +
        -2 * gray[y * dw + (x - 1)]   + 2 * gray[y * dw + (x + 1)] +
        -gray[(y + 1) * dw + (x - 1)] + gray[(y + 1) * dw + (x + 1)];
      sobel[y * dw + x] = Math.min(255, Math.abs(gx));
    }
  }

  // ── Binarise using module-level SOBEL_THRESH ──────────────────────────────
  const binary = new Uint8Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) {
    binary[i] = sobel[i] > SOBEL_THRESH ? 1 : 0;
  }

  // ── Horizontal dilation – connect character vertical edges ─────────────────
  const dilW  = Math.max(5, Math.round(dw * 0.025));
  const hDil  = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let on = 0;
      for (let dx = -dilW; dx <= dilW && !on; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < dw) on = binary[y * dw + nx];
      }
      hDil[y * dw + x] = on;
    }
  }

  // ── Vertical dilation – merge character rows into a plate band ─────────────
  const dilH = Math.max(3, Math.round(dh * 0.015));
  const vDil = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let on = 0;
      for (let dy = -dilH; dy <= dilH && !on; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < dh) on = hDil[ny * dw + x];
      }
      vDil[y * dw + x] = on;
    }
  }

  // ── Group consecutive dense rows into horizontal bands ─────────────────────
  const bands = [];
  let inBand = false, bandStart = 0;
  for (let y = 0; y < dh; y++) {
    let count = 0;
    for (let x = 0; x < dw; x++) count += vDil[y * dw + x];
    const dense = (count / dw) >= ROW_DENSITY_THRESH;
    if (dense  && !inBand) { inBand = true;  bandStart = y; }
    if (!dense &&  inBand) { inBand = false; bands.push({ y0: bandStart, y1: y - 1 }); }
  }
  if (inBand) bands.push({ y0: bandStart, y1: dh - 1 });

  // ── Filter bands by aspect ratio ───────────────────────────────────────────
  const candidates = [];
  for (const band of bands) {
    let minX = dw, maxX = 0;
    for (let y = band.y0; y <= band.y1; y++) {
      for (let x = 0; x < dw; x++) {
        if (vDil[y * dw + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (maxX <= minX) continue;
    const bw = maxX - minX + 1;
    const bh = band.y1 - band.y0 + 1;
    const ar = bw / bh;
    if (ar < PLATE_MIN_AR || ar > PLATE_MAX_AR)   continue;
    if (bw < dw * PLATE_MIN_WIDTH_PC)             continue;

    const arScore  = 1 / (1 + Math.abs(ar - PLATE_TARGET_AR));
    const areaNorm = (bw * bh) / (dw * dh);
    candidates.push({ x: minX, y: band.y0, w: bw, h: bh, score: arScore * AR_SCORE_WEIGHT + areaNorm });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Pad to avoid clipping edges and character descenders
  const padX = Math.round(best.w * 0.05);
  const padY = Math.round(best.h * 0.20);
  const cx   = Math.max(0, best.x - padX);
  const cy   = Math.max(0, best.y - padY);
  const cw   = Math.min(dw - cx, best.w + 2 * padX);
  const ch   = Math.min(dh - cy, best.h + 2 * padY);

  // Scale back to original-image coordinates
  return {
    x: Math.round(cx / scale),
    y: Math.round(cy / scale),
    w: Math.round(cw / scale),
    h: Math.round(ch / scale),
  };
}

/**
 * Draw a translucent bounding-box overlay on the preview image showing where
 * the plate detector found the plate.  Helps users understand and debug OCR.
 */
function drawPlateOverlay(plateRegion, naturalW, naturalH) {
  if (!plateOverlay) return;
  if (!plateRegion) { plateOverlay.style.display = 'none'; return; }

  // The <canvas> sits on top of the <img> which uses object-fit:contain inside
  // a fixed-size preview-box.  We need to map plate coords (in original image
  // pixels) to the rendered pixel position of the <img> element.
  const boxW = previewImg.clientWidth;
  const boxH = previewImg.clientHeight;
  const imgAR = naturalW / naturalH;
  const boxAR = boxW   / boxH;

  let renderedW, renderedH, offsetX, offsetY;
  if (imgAR > boxAR) {
    renderedW = boxW;
    renderedH = boxW / imgAR;
    offsetX   = 0;
    offsetY   = (boxH - renderedH) / 2;
  } else {
    renderedH = boxH;
    renderedW = boxH * imgAR;
    offsetX   = (boxW - renderedW) / 2;
    offsetY   = 0;
  }

  const scaleX = renderedW / naturalW;
  const scaleY = renderedH / naturalH;

  plateOverlay.width  = boxW;
  plateOverlay.height = boxH;
  plateOverlay.style.display = 'block';

  const ctx = plateOverlay.getContext('2d');
  ctx.clearRect(0, 0, boxW, boxH);
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth   = 3;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(
    offsetX + plateRegion.x * scaleX,
    offsetY + plateRegion.y * scaleY,
    plateRegion.w * scaleX,
    plateRegion.h * scaleY
  );
}

/**
 * Compute Otsu's optimal binarisation threshold for a grayscale pixel array.
 * This adaptive method picks the threshold that maximises between-class
 * variance, giving a clean black-and-white image regardless of lighting.
 */
function computeOtsuThreshold(pixels) {
  const histogram = new Array(256).fill(0);
  for (const v of pixels) histogram[v]++;
  const total = pixels.length;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) ** 2;
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

/**
 * Apply a 3×3 sharpening (Laplacian) kernel to a grayscale pixel array.
 * Sharpening makes character edges crisper, which helps Tesseract distinguish
 * visually similar glyphs such as W and H.
 */
function applySharpening(gray, w, h) {
  const out = new Uint8Array(gray);
  // Laplacian sharpening kernel: centre weight 5, cardinal neighbours -1
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const val = 5 * gray[i]
        - gray[i - w] - gray[i + w]
        - gray[i - 1] - gray[i + 1];
      out[i] = Math.min(255, Math.max(0, val));
    }
  }
  return out;
}

/**
 * Preprocess an image for OCR.
 *
 * Pipeline:
 *   1. Detect the plate region with detectPlateRegion() (or use the full image
 *      as a fallback when no plausible plate is found).
 *   2. Crop the image to that region.
 *   3. Scale the crop to OCR_PLATE_WIDTH (always — upscaling a small crop gives
 *      Tesseract more pixels to classify; downscaling removes noise from very
 *      large camera images).  Full-image fallback is capped at OCR_FULL_WIDTH.
 *   4. Convert to greyscale.
 *   5. Sharpen with the Laplacian kernel to accentuate character edges.
 *   6. Binarise with Otsu's adaptive threshold.
 *   7. Produce both a normal (dark-on-light) and an inverted copy (some plates
 *      have light characters on a dark surface; Tesseract prefers dark-on-light).
 *
 * Returns { normalUrl, invertUrl, plateRegion } where plateRegion is the
 * detected crop rectangle ({x,y,w,h}) or null for full-image fallback.
 */
async function preprocessImage(src) {
  const plateRegion = await detectPlateRegion(src);
  const img         = await loadImage(src);

  const fullW = img.naturalWidth  || img.width;
  const fullH = img.naturalHeight || img.height;

  // Determine the crop and target OCR width
  let cropX, cropY, cropW, cropH, targetW;
  if (plateRegion) {
    cropX   = plateRegion.x;
    cropY   = plateRegion.y;
    cropW   = plateRegion.w;
    cropH   = plateRegion.h;
    targetW = OCR_PLATE_WIDTH;             // scale crop to this width (up or down)
  } else {
    cropX   = 0;
    cropY   = 0;
    cropW   = fullW;
    cropH   = fullH;
    targetW = Math.min(fullW, OCR_FULL_WIDTH); // downscale only for full image
  }

  const scale = targetW / cropW;
  const w     = targetW;
  const h     = Math.round(cropH * scale);

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Draw only the plate crop, scaled to fill canvas
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, w, h);

  // --- Grayscale ---
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  }

  // --- Sharpen ---
  const sharpened = applySharpening(gray, w, h);

  // --- Otsu binarisation ---
  const threshold = computeOtsuThreshold(sharpened);

  // Build normal (dark text on white) image
  const normalData = ctx.createImageData(w, h);
  const invertData = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const val    = sharpened[i] > threshold ? 255 : 0;
    const invVal = 255 - val;
    normalData.data[i * 4]     = normalData.data[i * 4 + 1] = normalData.data[i * 4 + 2] = val;
    normalData.data[i * 4 + 3] = 255;
    invertData.data[i * 4]     = invertData.data[i * 4 + 1] = invertData.data[i * 4 + 2] = invVal;
    invertData.data[i * 4 + 3] = 255;
  }

  // Render normal image to canvas → data-URL
  ctx.putImageData(normalData, 0, 0);
  const normalUrl = canvas.toDataURL('image/png');

  // Render inverted image to canvas → data-URL
  ctx.putImageData(invertData, 0, 0);
  const invertUrl = canvas.toDataURL('image/png');

  return { normalUrl, invertUrl, plateRegion, naturalW: fullW, naturalH: fullH };
}

/**
 * Run OCR using multiple Tesseract page-segmentation modes (PSM) on both the
 * normal and the inverted preprocessed plate crop, then return the best result.
 *
 * Passes are tried in order and the loop exits as soon as any pass returns a
 * candidate within [MIN_PLATE_LENGTH, MAX_PLATE_LENGTH].  For a clear plate
 * crop (the common case) this means only one recognize() call is needed,
 * keeping total OCR time well under five seconds.  Subsequent modes serve as
 * automatic fallbacks for awkward lighting or unusual plate layouts.
 *
 * When a plate region is detected, PSM 7, 8 and 13 are tried (up to
 * 3 modes × 2 polarities = 6 passes) because the tight crop makes block-mode
 * PSMs unreliable.  Without a crop the full four-mode sweep is retained as a
 * fallback.
 *
 * PSM 7  – single text line  (best for a standard plate like "GF23 XWD")
 * PSM 8  – single word       (compact plates with no visible space)
 * PSM 13 – raw line          (no layout analysis; treats image as one line)
 * PSM 6  – uniform text block (fallback for full-image mode only)
 */
async function runOCR(imageSource) {
  if (!workerReady) {
    setOcrStatus('OCR not ready. Please type the registration manually.', false);
    return;
  }

  setOcrStatus('Detecting number plate…', true);
  validateBtn.disabled = true;

  try {
    const { normalUrl, invertUrl, plateRegion, naturalW, naturalH } = await preprocessImage(imageSource);

    // Show (or hide) the detection overlay on the preview
    drawPlateOverlay(plateRegion, naturalW, naturalH);

    if (plateRegion) {
      console.info('[OCR] Plate detected at', plateRegion);
    } else {
      console.warn('[OCR] No plate region detected — running OCR on full image');
    }

    setOcrStatus('Reading registration…', true);

    // Tight crop → single-line modes are most accurate.
    // Full-image fallback → also try block mode to catch plates with context.
    const PSM_MODES = plateRegion ? ['7', '8', '13'] : ['7', '6', '8', '13'];
    let bestInRange = '';  // longest candidate within [MIN_PLATE_LENGTH, MAX_PLATE_LENGTH]
    let bestAny     = '';  // longest candidate regardless of length (fallback)

    const tryCandidate = (raw) => {
      const candidate = cleanRegistration(raw || '');
      const inRange = candidate.length >= MIN_PLATE_LENGTH && candidate.length <= MAX_PLATE_LENGTH;
      if (inRange && candidate.length > bestInRange.length) bestInRange = candidate;
      if (candidate.length > bestAny.length) bestAny = candidate;
    };

    for (const psm of PSM_MODES) {
      await tesseractWorker.setParameters({ tessedit_pageseg_mode: psm });
      // Run on the standard (dark text on white) preprocessed image
      const { data: dataNormal } = await tesseractWorker.recognize(normalUrl);
      console.debug(`[OCR] PSM ${psm} normal: "${dataNormal.text.trim()}"`);
      tryCandidate(dataNormal.text);
      // Early exit: a valid-length plate was found — no further passes needed
      if (bestInRange.length > 0) break;
      // Run on the inverted image to handle light-coloured characters on dark plates
      const { data: dataInvert } = await tesseractWorker.recognize(invertUrl);
      console.debug(`[OCR] PSM ${psm} invert: "${dataInvert.text.trim()}"`);
      tryCandidate(dataInvert.text);
      // Early exit after inverted pass too
      if (bestInRange.length > 0) break;
    }

    let best = bestInRange || bestAny;

    if (best.length > 0) {
      // Apply UK plate format positional character corrections (O↔0, I↔1, etc.)
      best = correctOcrForUKPlate(best);

      // Fuzzy-match against stored registrations (edit distance ≤ 1) to catch
      // single-character misreads such as W being read as H
      const fuzzy = findFuzzyMatch(best, getRegistrations());
      if (fuzzy) best = fuzzy;

      regInput.value = best;
      const regionNote = plateRegion ? '' : ' (full image — plate not isolated)';
      setOcrStatus(`Detected: ${best}${regionNote}`, false);
    } else {
      setOcrStatus('Could not detect registration. Please type it manually.', false);
    }
  } catch (err) {
    console.error('OCR error:', err);
    setOcrStatus('OCR failed. Please type the registration manually.', false);
  } finally {
    validateBtn.disabled = false;
  }
}

/** Strip spaces, punctuation and uppercase */
function cleanRegistration(raw) {
  return raw.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

/**
 * Apply positional character corrections for the standard UK plate format
 * LL00LLL (2 letters, 2 digits, 3 letters).  OCR commonly confuses visually
 * similar characters: O/0, I/1, S/5, B/8, Z/2, G/6, A/4.
 * Only applied when the candidate is exactly 7 characters.
 */
function correctOcrForUKPlate(text) {
  if (text.length !== 7) return text;
  const DIGIT_TO_LETTER = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G', '4': 'A' };
  const LETTER_TO_DIGIT = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6', A: '4', T: '1' };
  const chars = text.split('');
  // Positions 0,1,4,5,6 should be letters – fix any stray digit
  [0, 1, 4, 5, 6].forEach(i => {
    if (/[0-9]/.test(chars[i]) && DIGIT_TO_LETTER[chars[i]]) {
      chars[i] = DIGIT_TO_LETTER[chars[i]];
    }
  });
  // Positions 2,3 should be digits – fix any stray letter
  [2, 3].forEach(i => {
    if (/[A-Z]/.test(chars[i]) && LETTER_TO_DIGIT[chars[i]]) {
      chars[i] = LETTER_TO_DIGIT[chars[i]];
    }
  });
  return chars.join('');
}

/** Levenshtein edit distance between two strings */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find a stored registration within edit-distance 1 of the candidate.
 * Returns the matched registration (normalised, spaces stripped) or null.
 */
function findFuzzyMatch(candidate, registrations) {
  for (const reg of registrations) {
    const norm = reg.replace(/\s/g, '').toUpperCase();
    if (levenshtein(candidate, norm) <= 1) return norm;
  }
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

validateBtn.addEventListener('click', validate);

/** Allow Enter key on reg input to trigger validation */
regInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') validate();
});

/** Normalise registration for comparison */
function normalise(reg) {
  return reg.replace(/\s/g, '').toUpperCase();
}

function validate() {
  const entered = normalise(regInput.value);

  if (!entered) {
    showToast('Please enter or capture a registration first.');
    return;
  }

  const stored = getRegistrations();
  const isValid = stored.map(normalise).includes(entered);

  showResult(entered, isValid);
}

// ─── Result Display ───────────────────────────────────────────────────────────

function showResult(reg, isValid) {
  resultCard.classList.remove('hidden', 'valid', 'invalid');
  resultCard.classList.add('visible', isValid ? 'valid' : 'invalid');
  resultBadge.classList.remove('result-valid', 'result-invalid');

  if (isValid) {
    resultIcon.textContent = '✅';
    resultBadge.textContent = reg;
    resultBadge.classList.add('result-valid');
    resultMessage.textContent = 'Permitted to Park';
    resultSub.textContent = 'This vehicle is registered for this car park.';
  } else {
    resultIcon.textContent = '❌';
    resultBadge.textContent = reg;
    resultBadge.classList.add('result-invalid');
    resultMessage.textContent = 'Not Permitted to Park';
    resultSub.textContent = 'This vehicle is NOT registered for this car park.';
  }

  // Scroll result into view
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetResult() {
  resultCard.classList.add('hidden');
  resultCard.classList.remove('visible', 'valid', 'invalid');
}

tryAgainBtn.addEventListener('click', () => {
  resetResult();
  regInput.value = '';
  previewImg.style.display = 'none';
  previewPlaceholder.style.display = 'flex';
  previewImg.src = '';
  setOcrStatus('', false);
  cameraInput.value = '';
  uploadInput.value = '';
  if (plateOverlay) plateOverlay.style.display = 'none';
  // Scroll back to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ─── Storage helpers ──────────────────────────────────────────────────────────

function getRegistrations() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setOcrStatus(msg, spinning) {
  if (!msg) {
    ocrStatus.innerHTML = '';
    return;
  }
  ocrStatus.innerHTML = spinning
    ? `<span class="spinner"></span><span>${escapeHtml(msg)}</span>`
    : `<span>${escapeHtml(msg)}</span>`;
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
