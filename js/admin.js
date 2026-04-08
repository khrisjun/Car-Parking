/**
 * admin.js – Car Parking Admin Panel
 *
 * Allows management of the valid parking registrations list stored in
 * localStorage, including add, remove, import (CSV) and export (CSV).
 */

'use strict';

const STORAGE_KEY = 'carpark_registrations';

// ─── DOM ───────────────────────────────────────────────────────────────────────
const addInput    = document.getElementById('add-input');
const addBtn      = document.getElementById('add-btn');
const regListEl   = document.getElementById('reg-list');
const regCountEl  = document.getElementById('reg-count');
const exportBtn   = document.getElementById('export-btn');
const importBtn   = document.getElementById('import-btn');
const importFile  = document.getElementById('import-file');

// ─── Init ──────────────────────────────────────────────────────────────────────
seedDefaultRegistrations();
renderList();

function seedDefaultRegistrations() {
  if (!localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_REGISTRATIONS));
  }
}

// ─── Render ────────────────────────────────────────────────────────────────────
function renderList() {
  const regs = getRegistrations();
  regCountEl.textContent = `${regs.length} registration${regs.length !== 1 ? 's' : ''} stored`;

  if (regs.length === 0) {
    regListEl.innerHTML = `
      <li class="empty-state">
        <span class="icon">🚗</span>
        No registrations saved yet. Add one above.
      </li>`;
    return;
  }

  regListEl.innerHTML = regs
    .map((reg, idx) => `
      <li>
        <span>${escapeHtml(reg)}</span>
        <button class="remove-btn" aria-label="Remove ${escapeHtml(reg)}" data-idx="${idx}">✕</button>
      </li>`)
    .join('');

  // Attach remove handlers
  regListEl.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeRegistration(Number(btn.dataset.idx)));
  });
}

// ─── Add ───────────────────────────────────────────────────────────────────────
addBtn.addEventListener('click', addRegistration);
addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRegistration(); });

function addRegistration() {
  const raw = addInput.value.trim();
  const reg = normalise(raw);

  if (!reg) {
    showToast('Please enter a registration number.');
    return;
  }

  if (!/^[A-Z0-9]{2,10}$/.test(reg)) {
    showToast('Invalid format. Use 2–10 letters/numbers only.');
    return;
  }

  const regs = getRegistrations();
  if (regs.map(normalise).includes(reg)) {
    showToast(`${reg} is already in the list.`);
    return;
  }

  regs.push(reg);
  saveRegistrations(regs);
  addInput.value = '';
  renderList();
  showToast(`${reg} added.`);
}

// ─── Remove ────────────────────────────────────────────────────────────────────
function removeRegistration(idx) {
  const regs = getRegistrations();
  const removed = regs.splice(idx, 1)[0];
  saveRegistrations(regs);
  renderList();
  showToast(`${removed} removed.`);
}

// ─── Export CSV ────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const regs = getRegistrations();
  if (regs.length === 0) {
    showToast('Nothing to export.');
    return;
  }
  const csv = regs.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'registrations.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported registrations.csv');
});

// ─── Import CSV ────────────────────────────────────────────────────────────────
importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const lines = ev.target.result
      .split(/[\r\n,]+/)
      .map(l => normalise(l.trim()))
      .filter(l => /^[A-Z0-9]{2,10}$/.test(l));

    if (lines.length === 0) {
      showToast('No valid registrations found in file.');
      return;
    }

    const current = getRegistrations();
    const existing = current.map(normalise);
    const newOnes = lines.filter(r => !existing.includes(r));
    const merged = [...current, ...newOnes];
    saveRegistrations(merged);
    renderList();
    showToast(`Imported ${newOnes.length} new registration${newOnes.length !== 1 ? 's' : ''}.`);
  };
  reader.readAsText(file);
  importFile.value = '';
});

// ─── Storage ───────────────────────────────────────────────────────────────────
function getRegistrations() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRegistrations(regs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(regs));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function normalise(reg) {
  return reg.replace(/\s/g, '').toUpperCase();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
