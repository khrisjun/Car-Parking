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
const CONTRAST_BOOST     = 1.6;  // multiplier applied during OCR image preprocessing
const MIN_PLATE_LENGTH   = 5;    // shortest plausible registration (e.g. "A1BCR")
const MAX_PLATE_LENGTH   = 8;    // longest plausible registration (e.g. "AB12 CDE")

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

/**
 * Preprocess an image for OCR:
 *  - Resize to a manageable width (full-res camera photos overwhelm Tesseract)
 *  - Convert to grayscale and boost contrast so the plate stands out
 *
 * Returns a data-URL of the processed image.
 */
async function preprocessImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX_W = 1600;
      const MAX_H = 900;
      let w = img.naturalWidth  || img.width;
      let h = img.naturalHeight || img.height;

      // Shrink if necessary while preserving aspect ratio
      if (w > MAX_W || h > MAX_H) {
        const ratio = Math.min(MAX_W / w, MAX_H / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      // Grayscale + contrast boost
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // Linear contrast stretch centred at 128
        gray = Math.min(255, Math.max(0, (gray - 128) * CONTRAST_BOOST + 128));
        d[i] = d[i + 1] = d[i + 2] = gray;
      }
      ctx.putImageData(imgData, 0, 0);

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Run OCR using multiple Tesseract page-segmentation modes (PSM) and return
 * the best non-empty result.  PSMs tried, in priority order:
 *   7 – single text line (best for a standard plate like "GF23 XWD")
 *   8 – single word      (compact plates with no space)
 *  11 – sparse text      (fallback when plate is small in a large photo)
 *
 * All modes are always tried so a partial result from an earlier mode never
 * masks a better result from a later mode.  Among all candidates the one
 * whose length falls inside [MIN_PLATE_LENGTH, MAX_PLATE_LENGTH] and is
 * longest wins; only if no candidate lands in that range do we fall back to
 * the longest raw result.
 */
async function runOCR(imageSource) {
  if (!workerReady) {
    setOcrStatus('OCR not ready. Please type the registration manually.', false);
    return;
  }

  setOcrStatus('Reading registration…', true);
  validateBtn.disabled = true;

  try {
    const processed = await preprocessImage(imageSource);

    const PSM_MODES = ['7', '8', '11'];
    let bestInRange = '';  // longest candidate within [MIN_PLATE_LENGTH, MAX_PLATE_LENGTH]
    let bestAny     = '';  // longest candidate regardless of length (fallback)

    for (const psm of PSM_MODES) {
      await tesseractWorker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await tesseractWorker.recognize(processed);
      const candidate = cleanRegistration(data.text || '');
      const inRange = candidate.length >= MIN_PLATE_LENGTH && candidate.length <= MAX_PLATE_LENGTH;
      if (inRange && candidate.length > bestInRange.length) {
        bestInRange = candidate;
      }
      if (candidate.length > bestAny.length) {
        bestAny = candidate;
      }
    }

    const best = bestInRange || bestAny;

    if (best.length > 0) {
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
