/* global document, XMLHttpRequest, navigator */

'use strict';

const dropZone     = document.getElementById('dropZone');
const fileInput    = document.getElementById('fileInput');
const progressWrap = document.getElementById('progressWrap');
const progressBar  = document.getElementById('progressBar');
const progressLbl  = document.getElementById('progressLabel');
const uploadStatus = document.getElementById('uploadStatus');
const fileListEl   = document.getElementById('fileList');
const emptyMsg     = document.getElementById('emptyMsg');

// ── Drag & Drop ───────────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});
dropZone.addEventListener('click', (e) => {
  if (e.target === fileInput || e.target.tagName === 'LABEL') return;
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

// ── Upload ────────────────────────────────────────────────────────────────────

function uploadFile(file) {
  const MAX = 100 * 1024 * 1024;
  if (file.size > MAX) {
    setStatus('error', `ไฟล์ใหญ่เกิน 100 MB · File exceeds 100 MB limit`);
    return;
  }

  const form = new FormData();
  form.append('file', file);

  progressWrap.hidden = false;
  progressBar.style.width = '0%';
  progressLbl.textContent = '0%';
  setStatus('', '');

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    progressBar.style.width = `${pct}%`;
    progressLbl.textContent = `${pct}%`;
  });

  xhr.addEventListener('load', () => {
    progressWrap.hidden = true;
    fileInput.value = '';

    if (xhr.status === 200 || xhr.status === 201) {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (data && data.downloadUrl) {
        setStatus('success', `✅ อัพโหลดสำเร็จ! / Upload complete: ${data.filename}`);
        loadFiles();
      } else {
        setStatus('error', 'อัพโหลดสำเร็จ แต่รับข้อมูลไม่ได้ · Upload OK but bad response');
      }
    } else {
      let msg = `Error ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
      setStatus('error', `❌ ${msg}`);
    }
  });

  xhr.addEventListener('error', () => {
    progressWrap.hidden = true;
    setStatus('error', '❌ เกิดข้อผิดพลาดในการเชื่อมต่อ · Network error');
  });

  xhr.send(form);
}

function setStatus(type, msg) {
  uploadStatus.textContent = msg;
  uploadStatus.className = `upload-status ${type}`;
}

// ── File List ─────────────────────────────────────────────────────────────────

function loadFiles() {
  fetch('/api/files')
    .then((r) => r.json())
    .then(({ files }) => renderFiles(files))
    .catch(() => setStatus('error', 'ไม่สามารถโหลดรายการไฟล์ได้ · Could not load file list'));
}

function renderFiles(files) {
  if (!files || files.length === 0) {
    fileListEl.innerHTML = '';
    fileListEl.appendChild(emptyMsg);
    emptyMsg.hidden = false;
    return;
  }

  emptyMsg.hidden = true;
  fileListEl.innerHTML = '';

  for (const f of files) {
    const safeUrl = safeHttpUrl(f.downloadUrl);
    const icon     = fileIcon(f.filename, f.mimeType);
    const size     = formatSize(f.size);
    const uploaded = formatDate(f.uploadedAt);
    const expires  = formatExpiry(f.expiresAt);
    const expClass = (f.expiresAt - Date.now()) < 2 * 60 * 60 * 1000 ? 'expires-soon' : '';

    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.id = f.id;

    item.innerHTML = `
      <span class="file-icon">${esc(icon)}</span>
      <div class="file-info">
        <div class="file-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
        <div class="file-meta">
          <span>📦 ${esc(size)}</span>
          <span>📅 ${esc(uploaded)}</span>
          <span class="${expClass}">⏳ หมดอายุ ${esc(expires)}</span>
          <span>⬇️ ${esc(String(f.downloadCount))} ครั้ง</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="btn btn-secondary btn-sm js-copy">📋 คัดลอก</button>
        <a class="btn btn-primary btn-sm" download>⬇️ ดาวน์โหลด</a>
      </div>`;

    // Set href via DOM property — never injected into innerHTML
    const dlLink = item.querySelector('a');
    if (safeUrl) dlLink.href = safeUrl;

    // Attach copy listener — closure over safeUrl, no inline handler
    item.querySelector('.js-copy').addEventListener('click', () => copyLink(safeUrl || f.downloadUrl));

    fileListEl.appendChild(item);
  }
}

function safeHttpUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

function copyLink(url) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('คัดลอกลิงก์แล้ว · Link copied!'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('คัดลอกลิงก์แล้ว · Link copied!');
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

function formatExpiry(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'แล้ว / Expired';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `ใน ${h} ชม. ${m} นาที`;
  return `ใน ${m} นาที`;
}

function fileIcon(name, mime) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'apk' || ext === 'aab') return '📱';
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return '🗜️';
  if (ext === 'pdf') return '📄';
  if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'aac', 'flac'].includes(ext)) return '🎵';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return '📊';
  if (mime && mime.startsWith('text/')) return '📝';
  return '📁';
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadFiles();
setInterval(loadFiles, 60000);
