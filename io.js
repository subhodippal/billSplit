/* =========================================================
   SplitEasy — export (PDF / image) and bulk import (text / Excel / CSV)
   Uses helpers from script.js (cur, me, push, computeBalances, …).
   ========================================================= */

const LIBS = {
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
};
const libLoads = {};
function loadLib(name){
  if(!libLoads[name]) libLoads[name] = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = LIBS[name];
    el.onload = resolve;
    el.onerror = () => { delete libLoads[name]; reject(new Error('Needs an internet connection the first time')); };
    document.head.appendChild(el);
  });
  return libLoads[name];
}

/* ================= EXPORT ================= */
$('exportBtn').onclick = () => openSheet('exportSheet');

document.querySelector('#exportSheet .export-options').addEventListener('click', async e => {
  const opt = e.target.closest('[data-export]');
  if(!opt || opt.disabled) return;
  const kind = opt.dataset.export;
  const label = opt.querySelector('strong'), orig = label.textContent;
  document.querySelectorAll('.export-opt').forEach(b => b.disabled = true);
  label.textContent = 'Preparing…';
  try{
    if(kind === 'pdf') await exportPdf(cur());
    else await exportImage(cur());
    closeSheet('exportSheet');
  } catch(err){
    toast('Export failed: ' + err.message);
  } finally {
    label.textContent = orig;
    document.querySelectorAll('.export-opt').forEach(b => b.disabled = false);
  }
});

// A clean, print-style page with everything in the split.
function reportHtml(s){
  const c = escapeHtml(s.currency);
  const money = n => `${c}${formatNum(n)}`;
  const entries = sortedEntries(s);
  const spent = entries.filter(e => e.sign < 0).reduce((t, e) => t + e.amount, 0);
  const recv = entries.filter(e => e.sign > 0).reduce((t, e) => t + e.amount, 0);
  const { people, share, balance, transactions } = computeBalances(s);
  const paidOut = p => entries.filter(e => e.paidBy === p && e.sign < 0).reduce((t, e) => t + e.amount, 0);

  const meta = [
    s.location && `📍 ${escapeHtml(s.location)}`,
    `${s.members.length} people`,
    s.createdBy && `Created by ${escapeHtml(s.createdBy)} · ${formatDay(s.createdAt)}`
  ].filter(Boolean).join('  ·  ');

  const rows = entries.map(e => {
    const [d, t] = formatDateTime(e.datetime);
    const excluded = s.members.filter(m => !e.splitAmong.includes(m));
    const split = excluded.length === 0 ? 'Everyone' : e.splitAmong.map(escapeHtml).join(', ');
    return `<tr class="rp-break">
      <td class="rp-nowrap">${d}<small>${t}</small></td>
      <td>${escapeHtml(e.purpose)}${e.note ? `<small>${escapeHtml(e.note)}</small>` : ''}</td>
      <td>${escapeHtml(e.paidBy)}${e.payVia ? `<small>${escapeHtml(e.payVia)}</small>` : ''}</td>
      <td>${split}</td>
      <td class="rp-num ${e.sign < 0 ? 'rp-neg' : 'rp-pos'}">${e.sign < 0 ? '−' : '+'}${money(e.amount)}</td>
    </tr>`;
  }).join('');

  const balanceRows = people.map(p => {
    const b = balance[p];
    const label = b > 0.005 ? `gets back ${money(b)}` : b < -0.005 ? `owes ${money(-b)}` : 'settled';
    const cls = b > 0.005 ? 'rp-pos' : b < -0.005 ? 'rp-neg' : '';
    return `<tr class="rp-break"><td>${escapeHtml(p)}</td><td class="rp-num">${money(paidOut(p))}</td>
      <td class="rp-num">${money(share[p])}</td><td class="rp-num ${cls}">${label}</td></tr>`;
  }).join('');

  const settle = transactions.length
    ? transactions.map(t => `<div class="rp-settle rp-break"><strong>${escapeHtml(t.from)}</strong> pays <strong>${escapeHtml(t.to)}</strong><span>${money(t.amount)}</span></div>`).join('')
    : `<div class="rp-empty rp-break">${entries.length ? 'Everyone is even — no payments needed.' : 'Nothing to settle yet.'}</div>`;

  return `<div class="rp">
    <div class="rp-top"><span class="rp-brand">💸 SplitEasy</span><span>Exported ${formatStamp(Date.now())}</span></div>
    <div class="rp-type">${escapeHtml(s.type)} split</div>
    <h1>${escapeHtml(s.name)}</h1>
    <div class="rp-meta">${meta}</div>
    <div class="rp-stats rp-break">
      <div><span>Total spent</span><b>${money(spent)}</b></div>
      ${recv ? `<div><span>Received</span><b>${money(recv)}</b></div><div><span>Net cost</span><b>${money(spent - recv)}</b></div>` : ''}
      <div><span>Entries</span><b>${entries.length}</b></div>
      <div><span>People</span><b>${people.length}</b></div>
    </div>
    <h2 class="rp-break">Entries</h2>
    ${entries.length ? `<table class="rp-table"><thead><tr><th>Date</th><th>Purpose</th><th>Paid by</th><th>Split with</th><th class="rp-num">Amount</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '<div class="rp-empty">No entries yet.</div>'}
    <h2 class="rp-break">Balances</h2>
    <table class="rp-table"><thead><tr><th>Person</th><th class="rp-num">Paid</th><th class="rp-num">Share</th><th class="rp-num">Balance</th></tr></thead>
      <tbody>${balanceRows}</tbody></table>
    <h2 class="rp-break">Settle up</h2>
    ${settle}
    <div class="rp-foot rp-break">Made with SplitEasy · subhodippal.github.io/billSplit</div>
  </div>`;
}

// Draw the report off-screen; also return where rows start so PDF pages break between rows.
async function renderReport(s, scale){
  if(typeof html2canvas === 'undefined') await loadLib('html2canvas');
  const host = document.createElement('div');
  host.className = 'rp-host';
  host.innerHTML = reportHtml(s);
  document.body.appendChild(host);
  try{
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    const el = host.firstElementChild;
    const top = el.getBoundingClientRect().top;
    const breaks = [...el.querySelectorAll('.rp-break')].map(n => n.getBoundingClientRect().top - top);
    const canvas = await html2canvas(el, { scale: scale || 2, backgroundColor: '#ffffff', useCORS: true });
    return { canvas, breaks, cssWidth: el.offsetWidth };
  } finally {
    host.remove();
  }
}

async function exportImage(s){
  const { canvas } = await renderReport(s, 2);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  await saveFile(blob, `${slug(s.name)}.png`);
}

async function exportPdf(s){
  await loadLib('jspdf');
  const { canvas, breaks, cssWidth } = await renderReport(s, 2);
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
  const margin = 26;
  const ptPerPx = (pageW - margin * 2) / canvas.width;
  const pagePx = Math.floor((pageH - margin * 2) / ptPerPx);
  const cuts = breaks.map(b => Math.round(b * canvas.width / cssWidth));

  let y = 0, first = true;
  while(y < canvas.height - 2){
    let end = Math.min(y + pagePx, canvas.height);
    if(end < canvas.height){
      const fit = cuts.filter(b => b > y + 80 && b <= end);   // end the page before a row, not through it
      if(fit.length) end = Math.max(...fit);
    }
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = end - y;
    const ctx = slice.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, y, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
    if(!first) pdf.addPage();
    pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, canvas.width * ptPerPx, slice.height * ptPerPx);
    first = false;
    y = end;
  }
  await saveFile(pdf.output('blob'), `${slug(s.name)}.pdf`);
}

// Phones: open the share sheet (WhatsApp, Drive…); computers: download.
async function saveFile(blob, filename){
  const file = new File([blob], filename, { type: blob.type });
  const phone = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if(phone && navigator.canShare && navigator.canShare({ files: [file] })){
    try{ await navigator.share({ files: [file], title: filename }); return; }
    catch(err){ if(err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Saved ${filename}`);
}

/* ================= IMPORT ================= */
const IMPORT_FIELDS = {
  date: ['date', 'date & time', 'date and time', 'datetime', 'when', 'day', 'time'],
  purpose: ['purpose', 'description', 'item', 'what', 'details', 'title', 'expense', 'particulars'],
  amount: ['amount', 'amt', 'cost', 'price', 'total', 'value', 'rs', 'inr', '₹'],
  paidBy: ['paid by', 'paidby', 'payer', 'paid', 'who paid', 'by'],
  split: ['split with', 'split', 'split among', 'shared with', 'between', 'participants', 'for whom'],
  payVia: ['pay via', 'payment', 'payment mode', 'mode', 'method', 'via'],
  note: ['note', 'notes', 'remark', 'remarks', 'comment', 'comments']
};
const ORDER_WITH_DATE = ['date', 'purpose', 'amount', 'paidBy', 'split', 'payVia', 'note'];
const ORDER_NO_DATE = ['purpose', 'amount', 'paidBy', 'split', 'payVia', 'note'];
let importRows = [];
let importTimer;

$('importEntriesBtn').onclick = () => {
  $('importText').value = '';
  $('importFile').value = '';
  $('importPreview').innerHTML = '';
  importRows = [];
  updateImportButton();
  openSheet('importSheet');
  setTimeout(() => $('importText').focus(), 60);
};

$('importText').addEventListener('input', () => {
  clearTimeout(importTimer);
  importTimer = setTimeout(() => previewImport(splitDelimited($('importText').value)), 200);
});

$('importFile').addEventListener('change', async function(){
  const file = this.files[0];
  if(!file) return;
  try{
    let rows;
    if(/\.(xlsx|xls)$/i.test(file.name)){
      await loadLib('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    } else {
      rows = splitDelimited(await file.text());
    }
    // Show the file's rows in the box too, so they can be tweaked before importing.
    $('importText').value = rows.map(r => r.map(cellToText).map(v => /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join('\t')).join('\n');
    previewImport(rows);
  } catch(err){
    toast('Could not read that file: ' + err.message);
  }
});

$('importTemplateBtn').onclick = () => {
  const csv = '\uFEFF' + [
    'Date,Purpose,Amount,Paid by,Split with,Pay via,Note',
    `${todayDMY()} 20:30,Dinner,1200,${me()},all,UPI,`,
    `${todayDMY()} 09:15,Taxi,600,${me()},${me()}; Alex,Cash,to the airport`,
    `${todayDMY()},Deposit refund,+2000,${me()},all,Bank transfer,money received`
  ].join('\r\n');
  saveFile(new Blob([csv], { type: 'text/csv' }), 'spliteasy-import-template.csv');
};

function todayDMY(){
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function cellToText(v){
  if(v instanceof Date) return localStamp(v);
  return String(v ?? '').trim();
}

// CSV / TSV / pasted text -> rows of cells (handles quotes).
function splitDelimited(text){
  text = String(text || '').replace(/\r\n?/g, '\n');
  const firstLine = text.split('\n').find(l => l.trim()) || '';
  const delim = firstLine.includes('\t') ? '\t'
    : (firstLine.split(';').length > firstLine.split(',').length && !/[a-z];\s*[a-z]/i.test(firstLine) ? ';' : ',');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for(let i = 0; i < text.length; i++){
    const ch = text[i];
    if(quoted){
      if(ch === '"' && text[i + 1] === '"'){ cell += '"'; i++; }
      else if(ch === '"') quoted = false;
      else cell += ch;
    } else if(ch === '"' && cell.trim() === '') quoted = true;
    else if(ch === delim){ row.push(cell); cell = ''; }
    else if(ch === '\n'){ row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}

const normHead = v => String(v || '').toLowerCase().replace(/[^a-z₹&]+/g, ' ').trim();
function headerMap(row){
  const map = {};
  row.forEach((cell, i) => {
    const h = normHead(cell);
    for(const [field, names] of Object.entries(IMPORT_FIELDS)){
      if(!(field in map) && names.includes(h)){ map[field] = i; break; }
    }
  });
  return Object.keys(map).length >= 2 && ('purpose' in map || 'amount' in map) ? map : null;
}

function previewImport(rows){
  const s = cur();
  importRows = [];
  if(!rows.length){ $('importPreview').innerHTML = ''; updateImportButton(); return; }
  let map = headerMap(rows[0].map(cellToText));
  const body = map ? rows.slice(1) : rows;
  importRows = body.map(r => {
    const cells = r.map(v => v instanceof Date || typeof v === 'number' ? v : cellToText(v));
    let m = map;
    if(!m){
      const order = parseImportDate(cells[0]) ? ORDER_WITH_DATE : ORDER_NO_DATE;
      m = {};
      order.forEach((f, i) => { m[f] = i; });
      // "1200, Dinner" -> swap if the amount came first
      if(parseAmount(cells[m.amount]) === null && parseAmount(cells[m.purpose]) !== null){ const t = m.amount; m.amount = m.purpose; m.purpose = t; }
    }
    return toEntryDraft(s, field => (m[field] === undefined ? '' : cells[m[field]] ?? ''));
  });
  // "all" means everyone — including people this import adds to the group.
  const newcomers = dedupe(importRows.flatMap(r => [r.paidBy, ...(r.splitAll ? [] : r.splitAmong)])).filter(n => !hasName(s.members, n));
  importRows.forEach(r => { if(r.splitAll) r.splitAmong = dedupe(s.members.concat(newcomers)); });
  renderImportPreview(s);
  updateImportButton();
}

function parseAmount(v){
  // Numbers from Excel are expenses; money received is written as "+500" or "500 received".
  if(typeof v === 'number') return isFinite(v) && v !== 0 ? { amount: round2(Math.abs(v)), sign: -1 } : null;
  const str = String(v || '').trim();
  if(!str) return null;
  const sign = /^\+/.test(str) || /(received|refund|credit|cr)$/i.test(str) ? 1 : -1;
  const num = parseFloat(str.replace(/[^0-9.\-]/g, '').replace(/^-/, ''));
  return num > 0 ? { amount: round2(num), sign } : null;
}

function localStamp(d){
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Accepts Excel dates/serials, 2026-10-06 14:30, 06/10/2026, 6-10-26 8:15 pm, "6 Oct 2026"…
// Day/month order is read the Indian way (day first).
function parseImportDate(v){
  if(v instanceof Date && !isNaN(v)) return localStamp(v);
  if(typeof v === 'number' && v > 20000 && v < 80000){
    const d = new Date(Math.round((v - 25569) * 86400000));
    return localStamp(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()));
  }
  const str = String(v || '').trim();
  if(!str) return null;
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if(m) return build(+m[1], +m[2], +m[3], m[4], m[5], '');
  m = str.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[ ,]+(\d{1,2})[:.](\d{2})\s*(am|pm)?)?$/i);
  if(m) return build(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1], m[4], m[5], m[6]);
  if(/[a-z]{3}/i.test(str) && /\d/.test(str)){
    const d = new Date(str);
    if(!isNaN(d)) return localStamp(/\d:\d\d/.test(str) ? d : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0));
  }
  return null;

  function build(y, mo, d, h, mi, ap){
    let hh = h === undefined ? 12 : +h;
    if(ap && /pm/i.test(ap) && hh < 12) hh += 12;
    if(ap && /am/i.test(ap) && hh === 12) hh = 0;
    const date = new Date(y, mo - 1, d, hh, mi === undefined ? 0 : +mi);
    return date.getMonth() === mo - 1 && date.getDate() === d ? localStamp(date) : null;
  }
}

function matchName(s, raw){
  const name = cleanName(raw);
  if(!name) return '';
  if(/^(me|you|myself)$/i.test(name)) return me();
  return s.members.find(m => m.toLowerCase() === name.toLowerCase()) || name;
}

function toEntryDraft(s, get){
  const errors = [];
  const purpose = cellToText(get('purpose')).slice(0, 80);
  if(!purpose) errors.push('purpose missing');
  const amt = parseAmount(get('amount'));
  if(!amt) errors.push('amount missing');
  const rawDate = get('date');
  let datetime = nowLocal();
  if(cellToText(rawDate)){
    const parsed = parseImportDate(rawDate);
    if(parsed) datetime = parsed; else errors.push(`can’t read date “${cellToText(rawDate)}”`);
  }
  const paidBy = matchName(s, cellToText(get('paidBy'))) || me();
  const rawSplit = cellToText(get('split'));
  const splitAll = !rawSplit || /^(all|everyone|everybody|group)$/i.test(rawSplit);
  let splitAmong;
  if(splitAll){
    splitAmong = dedupe(s.members.concat(hasName(s.members, paidBy) ? [] : [paidBy]));   // widened in previewImport
  } else {
    splitAmong = dedupe(rawSplit.split(/[;|\/,&+]|\band\b/i).map(n => matchName(s, n)).filter(Boolean));
  }
  if(!splitAmong.length) errors.push('nobody to split with');
  return {
    error: errors.join(', '),
    splitAll,
    datetime, purpose,
    amount: amt ? amt.amount : 0,
    sign: amt ? amt.sign : -1,
    paidBy, splitAmong,
    payVia: cleanName(cellToText(get('payVia'))),
    note: cellToText(get('note')).slice(0, 200)
  };
}

function renderImportPreview(s){
  const c = escapeHtml(s.currency);
  const ok = importRows.filter(r => !r.error).length;
  const bad = importRows.length - ok;
  const everyone = r => r.splitAmong.length >= s.members.length && s.members.every(m => r.splitAmong.includes(m));
  const newPeople = dedupe(importRows.filter(r => !r.error).flatMap(r => [r.paidBy, ...r.splitAmong])).filter(n => !hasName(s.members, n));
  $('importPreview').innerHTML = `
    <div class="import-summary">
      <span class="ok">✓ ${ok} ready</span>${bad ? `<span class="bad">✗ ${bad} need fixing</span>` : ''}
      ${newPeople.length ? `<span class="hint" style="margin:0;">New people will be added: ${newPeople.map(escapeHtml).join(', ')}</span>` : ''}
    </div>
    <div class="import-table-wrap"><table class="import-table">
      <thead><tr><th></th><th>Date</th><th>Purpose</th><th class="num">Amount</th><th>Paid by</th><th>Split</th></tr></thead>
      <tbody>${importRows.map(r => {
        const [d] = formatDateTime(r.datetime);
        return `<tr class="${r.error ? 'bad' : ''}">
          <td>${r.error ? '✗' : '✓'}</td>
          <td class="nowrap">${d}</td>
          <td>${escapeHtml(r.purpose || '—')}${r.error ? `<small>${escapeHtml(r.error)}</small>` : ''}</td>
          <td class="num ${r.sign < 0 ? 'neg' : 'pos'}">${r.amount ? `${r.sign < 0 ? '−' : '+'}${c}${formatNum(r.amount)}` : '—'}</td>
          <td>${escapeHtml(r.paidBy)}</td>
          <td>${everyone(r) ? 'Everyone' : r.splitAmong.map(escapeHtml).join(', ')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function updateImportButton(){
  const ok = importRows.filter(r => !r.error).length;
  $('importConfirmBtn').disabled = !ok;
  $('importConfirmBtn').textContent = ok ? `Import ${ok} entr${ok === 1 ? 'y' : 'ies'}` : 'Import';
}

$('importConfirmBtn').onclick = async function(){
  const s = cur();
  const rows = importRows.filter(r => !r.error);
  if(!rows.length) return;
  this.disabled = true;
  try{
    if(!await ensurePeople(s, rows.flatMap(r => [r.paidBy, ...r.splitAmong]))) return;
    const modes = dedupe(rows.map(r => r.payVia).filter(m => m && !s.payModes.some(x => x.toLowerCase() === m.toLowerCase())));
    if(modes.length){ s.payModes.push(...modes); touch(s); await push({ type: 'saveSplitMeta', splitId: s.id }); }

    const now = Date.now();
    const added = rows.map((r, i) => {
      const payVia = r.payVia ? (s.payModes.find(x => x.toLowerCase() === r.payVia.toLowerCase()) || r.payVia) : '';
      const en = {
        id: newId('e'), datetime: r.datetime, amount: r.amount, sign: r.sign,
        purpose: r.purpose, payVia, paidBy: r.paidBy,
        location: '', geo: null, note: r.note, splitAmong: r.splitAmong,
        addedBy: me(), createdAt: now + i, updatedAt: now + i, updatedBy: me()
      };
      s.entries.push(en);
      return en;
    });
    touch(s);
    if(localMode()) persistSplits();
    else {
      for(const en of added){
        if(!await push({ type: 'saveEntry', splitId: s.id, entryId: en.id })) break;
      }
    }
    closeSheet('importSheet');
    renderSplitDetail(s.id, true);
    toast(`Imported ${added.length} entr${added.length === 1 ? 'y' : 'ies'}`);
  } finally {
    this.disabled = false;
  }
};
