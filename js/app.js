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
const OCR_TARGET_WIDTH   = 1600; // target width for pre-processed image fed to Tesseract

// ─── DOM References ───────────────────────────────────────────────────────────
const cameraInput    = document.getElementById('camera-input');
const uploadInput    = document.getElementById('upload-input');
const previewImg     = document.getElementById('preview-img');
const previewPlaceholder = document.getElementById('preview-placeholder');
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
    // OEM 3 = LSTM + legacy engine combined — more robust than LSTM-only for
    // difficult characters such as W vs H or partial reads
    tesseractWorker = await Tesseract.createWorker('eng', 3 /* OEM_DEFAULT */, {
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
 * Preprocess an image for OCR and return two data-URLs: one normal (dark
 * characters on light background) and one inverted (light on dark).
 *
 * Pipeline:
 *   1. Scale image DOWN to OCR_TARGET_WIDTH if it is wider (large camera
 *      photos have more pixels than Tesseract can handle efficiently).
 *      Upscaling is intentionally skipped — interpolated pixels add no detail.
 *   2. Convert to grayscale.
 *   3. Sharpen with a Laplacian kernel to accentuate character edges.
 *   4. Binarise using Otsu's adaptive threshold for a clean black-and-white
 *      image regardless of ambient lighting conditions.
 *   5. Produce an inverted copy (some plates have light characters on a dark
 *      surface and Tesseract prefers dark-on-light).
 */
async function preprocessImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth  || img.width;
      let h = img.naturalHeight || img.height;

      // Only scale DOWN large photos; upscaling merely interpolates pixels and
      // does not give Tesseract more real detail.
      if (w > OCR_TARGET_WIDTH) {
        const scale = OCR_TARGET_WIDTH / w;
        w = OCR_TARGET_WIDTH;
        h = Math.round(h * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

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

      resolve({ normalUrl, invertUrl });
    };
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Run OCR using multiple Tesseract page-segmentation modes (PSM) on both the
 * normal and the inverted preprocessed image, then return the best result.
 *
 * PSMs tried:
 *   6  – uniform block of text (good for plates with clear borders)
 *   7  – single text line      (best for a standard plate like "GF23 XWD")
 *   8  – single word           (compact plates with no space)
 *  13  – raw line              (treats image as a single text line, no layout)
 *
 * Each mode is run on both the normal and inverted preprocessed image (8
 * passes total).  Running both polarities handles dark-on-light and
 * light-on-dark plates; the extra passes are the main accuracy trade-off
 * versus processing time.  On modern mobile hardware each pass takes ~1–2 s.
 * MAX_PLATE_LENGTH] and is longest wins; only if no candidate lands in that
 * range do we fall back to the longest raw result.
 */
async function runOCR(imageSource) {
  if (!workerReady) {
    setOcrStatus('OCR not ready. Please type the registration manually.', false);
    return;
  }

  setOcrStatus('Reading registration…', true);
  validateBtn.disabled = true;

  try {
    const { normalUrl, invertUrl } = await preprocessImage(imageSource);

    // PSM modes ordered from most to least specific for a plate
    const PSM_MODES = ['7', '6', '8', '13'];
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
      tryCandidate(dataNormal.text);
      // Run on the inverted image to handle light-coloured characters on dark plates
      const { data: dataInvert } = await tesseractWorker.recognize(invertUrl);
      tryCandidate(dataInvert.text);
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
      setOcrStatus(`Detected: ${best}`, false);
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
