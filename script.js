/* =========================================================
   SplitEasy — group bill splitter (static, offline-first)
   ========================================================= */

/* ---------------- PWA INSTALL ---------------- */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').style.display = 'inline-block';
});
document.getElementById('installBtn').addEventListener('click', async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').style.display = 'none';
});

/* ---------------- STORAGE ---------------- */
const USER_KEY = 'se_user';
const SPLITS_KEY = 'se_splits';
const DEFAULT_PAY_MODES = ['Cash', 'UPI', 'Card', 'Bank transfer'];
const NEW_OPTION = '__new__';

function load(key, fallback){
  try{ const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch(_){ return fallback; }
}
function save(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }
  catch(_){ toast('Could not save — storage is full or blocked'); }
}

let user = load(USER_KEY, null);          // {name, email}
let splits = load(SPLITS_KEY, {});        // {id: split}

function persistSplits(){ save(SPLITS_KEY, splits); }
function getSplit(id){ return splits[id] || null; }
function liveEntries(split){ return split.entries.filter(e => !e.deleted); }
function touch(obj){ obj.updatedAt = Date.now(); if(user) obj.updatedBy = user.name; }

/* ---------------- AUTH ---------------- */
let afterLogin = null;

function renderAuth(){
  const area = $('authArea');
  if(user){
    area.innerHTML = `
      <div class="user-pill">
        <span class="user-avatar">${escapeHtml(initials(user.name))}</span>
        <span class="user-name">${escapeHtml(user.name)}</span>
        <button class="btn-ghost-light btn-small" id="logoutBtn">Log out</button>
      </div>`;
    $('logoutBtn').onclick = () => {
      if(!confirm('Log out? Your splits stay saved on this device.')) return;
      user = null;
      localStorage.removeItem(USER_KEY);
      renderAuth();
      route();
    };
  } else {
    area.innerHTML = `<button class="btn-primary btn-small" id="loginBtn">Log in</button>`;
    $('loginBtn').onclick = () => openLogin();
  }
}

function openLogin(then){
  afterLogin = then || null;
  $('loginName').value = user ? user.name : '';
  $('loginEmail').value = user ? (user.email || '') : '';
  openSheet('loginSheet');
  setTimeout(() => $('loginName').focus(), 50);
}

function requireLogin(then){
  if(user){ then(); return; }
  toast('Log in first so entries carry your name');
  openLogin(then);
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = cleanName($('loginName').value);
  if(!name) return;
  user = { name, email: $('loginEmail').value.trim() };
  save(USER_KEY, user);
  closeSheet('loginSheet');
  renderAuth();
  toast(`Welcome, ${name}!`);
  const next = afterLogin; afterLogin = null;
  if(next) next(); else route();
});

/* ---------------- SHEETS / TOAST ---------------- */
function openSheet(id){ $(id).hidden = false; document.body.classList.add('no-scroll'); }
function closeSheet(id){
  $(id).hidden = true;
  if(document.querySelectorAll('.sheet-backdrop:not([hidden])').length === 0) document.body.classList.remove('no-scroll');
}
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close-sheet]');
  if(closer){ closeSheet(closer.closest('.sheet-backdrop').id); return; }
  if(e.target.classList && e.target.classList.contains('sheet-backdrop')) closeSheet(e.target.id);
});
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  document.querySelectorAll('.sheet-backdrop:not([hidden])').forEach(s => closeSheet(s.id));
});

let toastTimer;
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------- ROUTER ---------------- */
function showView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  window.scrollTo(0, 0);
}

function route(){
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  const arg = rest.join('/');
  document.querySelectorAll('.sheet-backdrop:not([hidden])').forEach(s => closeSheet(s.id));

  if(page === 'splits') return renderSplitList();
  if(page === 'new') return renderSplitForm(null);
  if(page === 'edit' && getSplit(arg)) return renderSplitForm(arg);
  if(page === 'split' && getSplit(arg)) return renderSplitDetail(arg);
  if(page === 'import' && arg) return renderImport(arg);
  if(page && page !== '') { location.hash = '#/'; return; }
  renderHome();
}
window.addEventListener('hashchange', route);

/* ---------------- HOME ---------------- */
function renderHome(){
  const count = Object.keys(splits).length;
  $('homeGreeting').textContent = user ? `Hey ${user.name}, split it fairly.` : 'Split every bill, fairly.';
  $('homeSplitCount').textContent = count ? `${count} split${count > 1 ? 's' : ''} saved →` : 'Nothing yet — create your first one';
  showView('home');
}

/* ---------------- SPLIT LIST ---------------- */
function renderSplitList(){
  const list = Object.values(splits).sort((a, b) => b.updatedAt - a.updatedAt);
  const box = $('splitList');
  if(list.length === 0){
    box.innerHTML = `<div class="list-empty">
      <p>No splits yet. Create one for your next trip or party.</p>
      <a href="#/new" class="btn-primary btn-link" style="padding:11px 20px;">＋ Create new split</a>
    </div>`;
  } else {
    box.innerHTML = list.map(s => {
      const entries = liveEntries(s);
      const spent = entries.filter(e => e.sign < 0).reduce((t, e) => t + e.amount, 0);
      return `<a class="split-card" href="#/split/${encodeURIComponent(s.id)}">
        <div class="split-card-top">
          <span class="tag">${escapeHtml(s.type)}</span>
          <span class="hint" style="margin:0;">${formatDay(s.createdAt)}</span>
        </div>
        <div class="split-card-name">${escapeHtml(s.name)}</div>
        ${s.location ? `<div class="split-card-loc">📍 ${escapeHtml(s.location)}</div>` : ''}
        <div class="split-card-foot">
          <span>${s.members.length} people · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
          <span class="split-card-total">${escapeHtml(s.currency)}${formatNum(spent)}</span>
        </div>
      </a>`;
    }).join('');
  }
  showView('splits');
}

/* ---------------- CREATE / EDIT SPLIT ---------------- */
let draftMembers = [];
let draftGeo = null;
let editingSplitId = null;

function renderSplitForm(splitId){
  editingSplitId = splitId;
  const s = splitId ? getSplit(splitId) : null;
  $('newTitle').textContent = s ? 'Edit details' : 'New split';
  $('newBackLink').href = s ? `#/split/${encodeURIComponent(s.id)}` : '#/';
  $('newBackLink').textContent = s ? '← Back' : '← Home';
  $('splitSubmitBtn').textContent = s ? 'Save changes' : 'Create split →';
  $('splitName').value = s ? s.name : '';
  $('splitType').value = s ? s.type : 'Travel';
  $('splitCurrency').value = s ? s.currency : '₹';
  $('splitLocation').value = s ? (s.location || '') : '';
  draftGeo = s ? s.geo : null;
  renderGeoInfo('splitGeoInfo', draftGeo);
  // Members are managed on the split page once it exists
  document.querySelectorAll('#splitForm .perf, #splitForm .perf ~ .step-head, #splitForm .perf ~ .step-desc, #splitForm .add-inline, #memberChips')
    .forEach(el => el.style.display = s ? 'none' : '');
  draftMembers = user ? [user.name] : [];
  renderDraftMembers();
  showView('new');
  if(!s && !user) openLogin(() => renderSplitForm(null));
}

function renderDraftMembers(){
  $('memberChips').innerHTML = draftMembers.map(m => `
    <div class="chip"><span class="avatar-dot"></span><span>${escapeHtml(m)}</span>
      ${user && m === user.name ? '<span class="you">YOU</span>&nbsp;' :
        `<button type="button" class="chip-x" data-remove="${escapeHtml(m)}" title="Remove">×</button>`}
    </div>`).join('');
}

function addDraftMember(){
  const name = cleanName($('memberInput').value);
  if(!name) return;
  if(!hasName(draftMembers, name)) draftMembers.push(name);
  $('memberInput').value = '';
  $('memberInput').focus();
  renderDraftMembers();
}
$('memberAddBtn').onclick = addDraftMember;
$('memberInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); addDraftMember(); } });
$('memberChips').addEventListener('click', e => {
  const btn = e.target.closest('[data-remove]');
  if(!btn) return;
  draftMembers = draftMembers.filter(m => m !== btn.dataset.remove);
  renderDraftMembers();
});
$('splitGeoBtn').onclick = () => captureGeo($('splitGeoBtn'), $('splitLocation'), 'splitGeoInfo', g => { draftGeo = g; });

$('splitForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if(!editingSplitId && !user){ openLogin(() => $('splitForm').requestSubmit()); return; }
  const name = $('splitName').value.trim();
  if(!name){ $('splitName').focus(); return; }
  // pick up a name typed but not yet added
  if($('memberInput').value.trim()) addDraftMember();

  if(editingSplitId){
    const s = getSplit(editingSplitId);
    Object.assign(s, {
      name, type: $('splitType').value, currency: $('splitCurrency').value,
      location: $('splitLocation').value.trim(), geo: draftGeo
    });
    touch(s);
    persistSplits();
    toast('Details saved');
    location.hash = `#/split/${encodeURIComponent(s.id)}`;
    return;
  }

  const now = Date.now();
  const s = {
    id: uid('s'),
    name,
    type: $('splitType').value,
    currency: $('splitCurrency').value,
    location: $('splitLocation').value.trim(),
    geo: draftGeo,
    members: draftMembers.slice(),
    payModes: DEFAULT_PAY_MODES.slice(),
    entries: [],
    createdBy: user.name,
    createdAt: now,
    updatedAt: now,
    updatedBy: user.name
  };
  splits[s.id] = s;
  persistSplits();
  $('memberInput').value = '';
  toast('Split created');
  location.hash = `#/split/${encodeURIComponent(s.id)}`;
});

/* ---------------- SPLIT DETAIL ---------------- */
let currentSplitId = null;
function cur(){ return getSplit(currentSplitId); }

function renderSplitDetail(id){
  currentSplitId = id;
  const s = cur();
  $('detailType').textContent = `${s.type} split`;
  $('detailName').textContent = s.name;
  const meta = [];
  if(s.location){
    meta.push(s.geo
      ? `<a href="${mapUrl(s.geo)}" target="_blank" rel="noopener">📍 ${escapeHtml(s.location)}</a>`
      : `<span>📍 ${escapeHtml(s.location)}</span>`);
  } else if(s.geo){
    meta.push(`<a href="${mapUrl(s.geo)}" target="_blank" rel="noopener">📍 ${s.geo.lat.toFixed(4)}, ${s.geo.lng.toFixed(4)}</a>`);
  }
  meta.push(`<span>👥 ${s.members.length} people</span>`);
  meta.push(`<span>Created by ${escapeHtml(s.createdBy || '—')} · ${formatDay(s.createdAt)}</span>`);
  $('detailMeta').innerHTML = meta.join('');
  renderMembers();
  renderEntries();
  renderSettlement();
  showView('split');
}

/* --- members --- */
function renderMembers(){
  const s = cur();
  $('detailMembers').innerHTML = s.members.map(m => `
    <div class="chip">
      <span class="avatar-dot"></span>
      <button type="button" class="chip-name" data-rename="${escapeHtml(m)}" title="Rename">${escapeHtml(m)}</button>
      ${user && m === user.name ? '<span class="you">YOU</span>' : ''}
      <button type="button" class="chip-x" data-remove="${escapeHtml(m)}" title="Remove">×</button>
    </div>`).join('') || '<span class="hint">No one yet — add people below.</span>';
}

function addMember(split, rawName){
  const name = cleanName(rawName);
  if(!name) return null;
  const existing = split.members.find(m => m.toLowerCase() === name.toLowerCase());
  if(existing) return existing;
  split.members.push(name);
  touch(split);
  return name;
}

function addDetailMember(){
  const s = cur();
  const added = addMember(s, $('detailMemberInput').value);
  if(!added) return;
  $('detailMemberInput').value = '';
  persistSplits();
  renderSplitDetail(s.id);
  toast(`${added} added — included in new entries from now on`);
}
$('detailMemberAddBtn').onclick = addDetailMember;
$('detailMemberInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); addDetailMember(); } });

$('detailMembers').addEventListener('click', (e) => {
  const s = cur();
  const ren = e.target.closest('[data-rename]');
  const rem = e.target.closest('[data-remove]');
  if(ren) renameMember(s, ren.dataset.rename);
  if(rem) removeMember(s, rem.dataset.remove);
});

function renameMember(s, oldName){
  const input = prompt(`Rename "${oldName}" to:`, oldName);
  if(input === null) return;
  const newName = cleanName(input);
  if(!newName || newName === oldName) return;
  const clash = s.members.find(m => m !== oldName && m.toLowerCase() === newName.toLowerCase());
  if(clash && !confirm(`"${clash}" already exists. Merge "${oldName}" into "${clash}"?`)) return;
  const target = clash || newName;

  s.members = dedupe(s.members.map(m => m === oldName ? target : m));
  s.entries.forEach(en => {
    let changed = false;
    if(en.paidBy === oldName){ en.paidBy = target; changed = true; }
    if(en.splitAmong.includes(oldName)){ en.splitAmong = dedupe(en.splitAmong.map(n => n === oldName ? target : n)); changed = true; }
    if(changed) touch(en);
  });
  touch(s);
  persistSplits();
  renderSplitDetail(s.id);
  toast(`Renamed to ${target} everywhere`);
}

function removeMember(s, name){
  const entries = liveEntries(s);
  const paid = entries.filter(e => e.paidBy === name).length;
  if(paid){
    alert(`${name} paid for ${paid} entr${paid === 1 ? 'y' : 'ies'}. Change "Paid by" on those first, or tap the name to rename/merge.`);
    return;
  }
  const inSplits = entries.filter(e => e.splitAmong.includes(name)).length;
  const msg = inSplits
    ? `Remove ${name}? They'll be taken out of ${inSplits} entr${inSplits === 1 ? 'y' : 'ies'} and those costs re-shared among the rest.`
    : `Remove ${name} from this split?`;
  if(!confirm(msg)) return;
  s.members = s.members.filter(m => m !== name);
  s.entries.forEach(en => {
    if(en.splitAmong.includes(name)){ en.splitAmong = en.splitAmong.filter(n => n !== name); touch(en); }
  });
  touch(s);
  persistSplits();
  renderSplitDetail(s.id);
}

/* --- entries table --- */
function sortedEntries(s){
  return liveEntries(s).slice().sort((a, b) => (a.datetime || '').localeCompare(b.datetime || '') || a.createdAt - b.createdAt);
}

function renderEntries(){
  const s = cur();
  const entries = sortedEntries(s);
  const body = $('entryBody');
  const c = escapeHtml(s.currency);

  $('entryEmpty').style.display = entries.length ? 'none' : 'block';
  $('entryTable').style.display = entries.length ? '' : 'none';

  const spent = entries.filter(e => e.sign < 0).reduce((t, e) => t + e.amount, 0);
  const recv = entries.filter(e => e.sign > 0).reduce((t, e) => t + e.amount, 0);
  $('totalsStrip').innerHTML = entries.length ? `
    <span>Spent <b class="neg">−${c}${formatNum(spent)}</b></span>
    ${recv ? `<span>Received <b class="pos">+${c}${formatNum(recv)}</b></span>` : ''}
    <span>Net cost <b>${c}${formatNum(spent - recv)}</b></span>` : '';

  body.innerHTML = entries.map(e => {
    const excluded = s.members.filter(m => !e.splitAmong.includes(m));
    const everyone = excluded.length === 0;
    const signCls = e.sign < 0 ? 'minus' : 'plus';
    const [d, t] = formatDateTime(e.datetime);
    const onBehalf = e.addedBy && e.addedBy !== e.paidBy;
    const loc = e.location
      ? (e.geo ? `<a href="${mapUrl(e.geo)}" target="_blank" rel="noopener" data-stop>${escapeHtml(e.location)}</a>` : escapeHtml(e.location))
      : (e.geo ? `<a href="${mapUrl(e.geo)}" target="_blank" rel="noopener" data-stop>📍 map</a>` : '');
    return `<tr class="row-${signCls}" data-id="${e.id}">
      <td class="cell-date c-date" data-label="Date">${d}<small>${t}</small></td>
      <td class="num c-amount" data-label="Amount"><span class="amt ${signCls}">${e.sign < 0 ? '−' : '+'}${c}${formatNum(e.amount)}</span></td>
      <td class="c-purpose" data-label="Purpose">${escapeHtml(e.purpose)}</td>
      <td class="c-via ${e.payVia ? '' : 'c-empty'}" data-label="Via">${escapeHtml(e.payVia || '—')}</td>
      <td class="c-by" data-label="Paid by">${escapeHtml(e.paidBy)}${onBehalf ? `<span class="sub">added by ${escapeHtml(e.addedBy)}</span>` : ''}</td>
      <td class="cell-loc c-loc ${loc ? '' : 'c-empty'}" data-label="Location">${loc || '—'}</td>
      <td class="cell-note c-note ${e.note ? '' : 'c-empty'}" data-label="Note">${escapeHtml(e.note || '—')}</td>
      <td class="c-split" data-label="Split">${everyone ? 'Everyone' : `${e.splitAmong.length} of ${s.members.length}`}
        ${everyone ? '' : `<span class="excl-note">excl. ${excluded.map(escapeHtml).join(', ')}</span>`}</td>
      <td class="cell-actions">
        <button class="btn-icon" title="Edit" data-edit="${e.id}">✏️</button>
        <button class="btn-icon" title="Delete" data-delete="${e.id}">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

$('entryBody').addEventListener('click', (e) => {
  if(e.target.closest('[data-stop]')) return;
  const del = e.target.closest('[data-delete]');
  if(del){ deleteEntry(del.dataset.delete); return; }
  const row = e.target.closest('tr[data-id]');
  if(row) requireLogin(() => openEntrySheet(row.dataset.id));
});

function deleteEntry(id){
  const s = cur();
  const en = s.entries.find(x => x.id === id);
  if(!en || !confirm(`Delete "${en.purpose}"?`)) return;
  en.deleted = true;            // tombstone so the deletion syncs via share links
  touch(en); touch(s);
  persistSplits();
  closeSheet('entrySheet');
  renderSplitDetail(s.id);
  toast('Entry deleted');
}

/* ---------------- ENTRY SHEET ---------------- */
let editingEntryId = null;
let entrySign = -1;
let entryGeo = null;

$('addEntryBtn').onclick = () => requireLogin(() => openEntrySheet(null));

function openEntrySheet(entryId){
  const s = cur();
  editingEntryId = entryId;
  const en = entryId ? s.entries.find(x => x.id === entryId) : null;

  $('entryFormTitle').textContent = en ? 'Edit entry' : 'Add entry';
  $('eSubmitBtn').textContent = en ? 'Save changes' : 'Add entry';
  $('eDeleteBtn').style.display = en ? '' : 'none';

  $('eDate').value = en ? en.datetime : nowLocal();
  $('eAmount').value = en ? en.amount : '';
  setSign(en ? en.sign : -1);
  $('ePurpose').value = en ? en.purpose : '';
  $('eLocation').value = en ? (en.location || '') : (lastEntryLocation(s) || '');
  $('eNote').value = en ? (en.note || '') : '';
  entryGeo = en ? (en.geo || null) : null;
  renderGeoInfo('eGeoInfo', entryGeo);

  // Paid by defaults to the logged-in user (who may be new to a shared split)
  fillPaidBy(en ? en.paidBy : user.name);
  fillPayVia(en ? en.payVia : (lastPayVia(s) || s.payModes[0]));
  renderSplitPills(en ? en.splitAmong : s.members.concat(hasName(s.members, user.name) ? [] : [user.name]));
  $('purposeList').innerHTML = dedupe(liveEntries(s).map(x => x.purpose)).map(p => `<option value="${escapeHtml(p)}">`).join('');

  $('eAddedBy').innerHTML = en
    ? `Added by <strong>${escapeHtml(en.addedBy || '—')}</strong> · ${formatStamp(en.createdAt)}` +
      (en.updatedBy && en.updatedAt !== en.createdAt ? ` &nbsp;·&nbsp; last edited by <strong>${escapeHtml(en.updatedBy)}</strong> · ${formatStamp(en.updatedAt)}` : '')
    : `Will be added by <strong>${escapeHtml(user.name)}</strong>. Paying on behalf of someone? Just change <em>Paid by</em>.`;

  openSheet('entrySheet');
  if(!en) setTimeout(() => $('eAmount').focus(), 60);
}

function setSign(sign){
  entrySign = sign;
  const btn = $('eSign');
  const minus = sign < 0;
  btn.textContent = minus ? '−' : '+';
  btn.className = 'sign-toggle ' + (minus ? 'minus' : 'plus');
  $('eAmount').parentElement.className = 'amount-field ' + (minus ? 'minus' : 'plus');
  $('eSignHint').textContent = minus
    ? 'Expense (deducted). Tap − to switch to + for money received / refunds.'
    : 'Money received (refund, deposit back, collected cash). Tap + to switch back to an expense.';
}
$('eSign').onclick = () => setSign(-entrySign);

function fillPaidBy(selected){
  const s = cur();
  const names = s.members.slice();
  if(user && !hasName(names, user.name)) names.push(user.name);
  if(selected && !names.includes(selected)) names.push(selected);
  fillSelect($('ePaidBy'), names, selected, '＋ Add new person…', n => user && n === user.name ? `${n} (you)` : n);
}

function fillPayVia(selected){
  const s = cur();
  const modes = s.payModes.slice();
  if(selected && !modes.includes(selected)) modes.push(selected);
  fillSelect($('ePayVia'), modes, selected, '＋ Add new…');
}

function fillSelect(sel, values, selected, newLabel, labelFn){
  sel.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(labelFn ? labelFn(v) : v)}</option>`).join('') +
    `<option value="${NEW_OPTION}">${newLabel}</option>`;
  sel.value = values.includes(selected) ? selected : (values[0] || '');
  sel.dataset.prev = sel.value;
}

$('ePaidBy').addEventListener('change', function(){
  if(this.value !== NEW_OPTION){ this.dataset.prev = this.value; return; }
  const name = cleanName(prompt('Name of the person who paid:') || '');
  if(!name){ this.value = this.dataset.prev; return; }
  const s = cur();
  const added = addMember(s, name);
  persistSplits();
  const checked = getCheckedSplit();
  fillPaidBy(added);
  renderSplitPills(dedupe(checked.concat(added)));
  renderMembers();
  toast(`${added} added to the group`);
});

$('ePayVia').addEventListener('change', function(){
  if(this.value !== NEW_OPTION){ this.dataset.prev = this.value; return; }
  const mode = cleanName(prompt('New payment method (e.g. Paytm, GPay, Credit card):') || '');
  if(!mode){ this.value = this.dataset.prev; return; }
  const s = cur();
  const existing = s.payModes.find(m => m.toLowerCase() === mode.toLowerCase());
  if(!existing){ s.payModes.push(mode); touch(s); persistSplits(); }
  fillPayVia(existing || mode);
});

function renderSplitPills(selected){
  const s = cur();
  const names = s.members.slice();
  selected.forEach(n => { if(!names.includes(n)) names.push(n); });
  $('eSplitBox').innerHTML = names.map(n => {
    const on = selected.includes(n);
    return `<label class="split-pill ${on ? 'active' : ''}">
      <input type="checkbox" data-name="${escapeHtml(n)}" ${on ? 'checked' : ''}>${escapeHtml(n)}</label>`;
  }).join('');
  updateSplitCount();
}
$('eSplitBox').addEventListener('change', (e) => {
  if(e.target.matches('input[type=checkbox]')){
    e.target.parentElement.classList.toggle('active', e.target.checked);
    updateSplitCount();
  }
});
function getCheckedSplit(){
  return Array.from(document.querySelectorAll('#eSplitBox input:checked')).map(i => i.dataset.name);
}
function updateSplitCount(){
  const total = document.querySelectorAll('#eSplitBox input').length;
  const on = getCheckedSplit().length;
  $('eSplitCount').textContent = `(${on} of ${total})`;
}
function setAllPills(on){
  document.querySelectorAll('#eSplitBox input').forEach(i => { i.checked = on; i.parentElement.classList.toggle('active', on); });
  updateSplitCount();
}
$('eSplitAll').onclick = () => setAllPills(true);
$('eSplitNone').onclick = () => setAllPills(false);

$('eGeoBtn').onclick = () => captureGeo($('eGeoBtn'), $('eLocation'), 'eGeoInfo', g => { entryGeo = g; });
$('eDeleteBtn').onclick = () => deleteEntry(editingEntryId);

$('entryForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = cur();
  const amount = parseFloat($('eAmount').value);
  const purpose = $('ePurpose').value.trim();
  const paidBy = $('ePaidBy').value;
  const payVia = $('ePayVia').value === NEW_OPTION ? '' : $('ePayVia').value;
  const splitAmong = getCheckedSplit();

  if(!(amount > 0)){ toast('Enter an amount greater than 0'); $('eAmount').focus(); return; }
  if(!purpose){ toast('What was it for?'); $('ePurpose').focus(); return; }
  if(!paidBy || paidBy === NEW_OPTION){ toast('Choose who paid'); return; }
  if(splitAmong.length === 0){ toast('Pick at least one person to share this with'); return; }

  // Anyone involved becomes a group member
  [paidBy, ...splitAmong].forEach(n => addMember(s, n));

  const data = {
    datetime: $('eDate').value || nowLocal(),
    amount: round2(amount),
    sign: entrySign,
    purpose, payVia, paidBy,
    location: $('eLocation').value.trim(),
    geo: entryGeo,
    note: $('eNote').value.trim(),
    splitAmong
  };

  if(editingEntryId){
    const en = s.entries.find(x => x.id === editingEntryId);
    Object.assign(en, data);
    touch(en);
    toast('Entry updated');
  } else {
    const now = Date.now();
    s.entries.push({ id: uid('e'), ...data, addedBy: user.name, createdAt: now, updatedAt: now, updatedBy: user.name });
    toast('Entry added');
  }
  touch(s);
  persistSplits();
  closeSheet('entrySheet');
  renderSplitDetail(s.id);
});

function lastEntry(s){ return sortedEntries(s).slice(-1)[0]; }
function lastPayVia(s){ const l = lastEntry(s); return l && l.payVia; }
function lastEntryLocation(s){ const l = lastEntry(s); return l && l.location; }

/* ---------------- SETTLEMENT ---------------- */
function computeBalances(s){
  const entries = liveEntries(s);
  const people = dedupe(s.members.concat(...entries.map(e => [e.paidBy, ...e.splitAmong])));
  const paid = {}, share = {};
  people.forEach(p => { paid[p] = 0; share[p] = 0; });

  // An expense (−): payer put money in, each sharer owes a slice.
  // A receipt (+): receiver holds group money, each sharer is owed a slice back.
  entries.forEach(e => {
    if(!e.splitAmong.length) return;
    const signed = -e.sign * e.amount;
    paid[e.paidBy] += signed;
    const per = signed / e.splitAmong.length;
    e.splitAmong.forEach(n => { share[n] += per; });
  });

  const balance = {};
  people.forEach(p => { balance[p] = round2(paid[p] - share[p]); });

  const creditors = people.filter(p => balance[p] > 0.005).map(p => ({ name: p, amt: balance[p] })).sort((a, b) => b.amt - a.amt);
  const debtors = people.filter(p => balance[p] < -0.005).map(p => ({ name: p, amt: -balance[p] })).sort((a, b) => b.amt - a.amt);
  const transactions = [];
  let ci = 0, di = 0;
  while(ci < creditors.length && di < debtors.length){
    const c = creditors[ci], d = debtors[di];
    const amt = Math.min(c.amt, d.amt);
    if(amt > 0.005) transactions.push({ from: d.name, to: c.name, amount: round2(amt) });
    c.amt = round2(c.amt - amt);
    d.amt = round2(d.amt - amt);
    if(c.amt <= 0.005) ci++;
    if(d.amt <= 0.005) di++;
  }
  return { people, paid, share, balance, transactions };
}

function renderSettlement(){
  const s = cur();
  const c = escapeHtml(s.currency);
  const entries = liveEntries(s);
  const spent = entries.filter(e => e.sign < 0).reduce((t, e) => t + e.amount, 0);
  const recv = entries.filter(e => e.sign > 0).reduce((t, e) => t + e.amount, 0);
  const { people, share, balance, transactions } = computeBalances(s);

  $('statGrid').innerHTML = `
    <div class="stat-box"><div class="stat-label">Total spent</div><div class="stat-value">${c}${formatNum(spent)}</div></div>
    ${recv ? `<div class="stat-box"><div class="stat-label">Received</div><div class="stat-value">${c}${formatNum(recv)}</div></div>` : ''}
    <div class="stat-box"><div class="stat-label">People</div><div class="stat-value">${people.length}</div></div>
    <div class="stat-box"><div class="stat-label">Entries</div><div class="stat-value">${entries.length}</div></div>`;

  $('shareList').innerHTML = people.length ? people.map(p => {
    const b = balance[p];
    const cls = b > 0.005 ? 'bal-pos' : (b < -0.005 ? 'bal-neg' : 'bal-zero');
    const label = b > 0.005 ? `gets back ${c}${formatNum(b)}` : (b < -0.005 ? `owes ${c}${formatNum(-b)}` : 'settled');
    return `<div class="person-row">
      <span class="person-name">${escapeHtml(p)}
        <span class="person-sub">${personSummary(entries, p, c)} · share ${c}${formatNum(share[p])}</span></span>
      <span class="${cls}">${label}</span>
    </div>`;
  }).join('') : '<div class="settle-empty">Add people and entries to see balances.</div>';

  $('settleList').innerHTML = transactions.length
    ? transactions.map(t => `<div class="settle-row">
        <strong>${escapeHtml(t.from)}</strong><span class="arrow">→</span><strong>${escapeHtml(t.to)}</strong>
        <span class="amt">${c}${formatNum(t.amount)}</span></div>`).join('')
    : `<div class="settle-empty">${entries.length ? "Everyone's even. No payments needed 🎉" : 'Nothing to settle yet.'}</div>`;
}

function personSummary(entries, p, c){
  const out = entries.filter(e => e.paidBy === p && e.sign < 0).reduce((t, e) => t + e.amount, 0);
  const got = entries.filter(e => e.paidBy === p && e.sign > 0).reduce((t, e) => t + e.amount, 0);
  const parts = [`paid ${c}${formatNum(out)}`];
  if(got) parts.push(`received ${c}${formatNum(got)}`);
  return parts.join(' · ');
}

$('snapshotBtn').onclick = function(){
  if(typeof html2canvas === 'undefined'){ toast('Snapshot needs an internet connection'); return; }
  const s = cur();
  const btn = this, orig = btn.textContent;
  btn.textContent = 'Preparing…'; btn.disabled = true;
  html2canvas($('downloadArea'), { backgroundColor: '#F4EFE1', scale: 2 }).then(canvas => {
    const link = document.createElement('a');
    link.download = `${slug(s.name)}-settle-up.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }).catch(err => alert('Could not generate snapshot: ' + err.message))
    .finally(() => { btn.textContent = orig; btn.disabled = false; });
};

$('editDetailsBtn').onclick = () => { location.hash = `#/edit/${encodeURIComponent(currentSplitId)}`; };

$('deleteSplitBtn').onclick = () => {
  const s = cur();
  if(!confirm(`Delete "${s.name}" and all its entries from this device? This can't be undone.`)) return;
  delete splits[s.id];
  persistSplits();
  toast('Split deleted');
  location.hash = '#/splits';
};

/* ---------------- SHARE / IMPORT ---------------- */
// No server: the whole split travels inside the link. Whoever opens it gets a
// copy; when they share back, entries are merged by id (newest edit wins).
$('shareBtn').onclick = async () => {
  const s = cur();
  const url = `${location.origin}${location.pathname}#/import/${await encodeSplit(s)}`;
  const text = `Join "${s.name}" on SplitEasy — add your expenses and share the link back so I can merge them:`;
  if(navigator.share){
    try{ await navigator.share({ title: `SplitEasy · ${s.name}`, text, url }); return; }
    catch(err){ if(err.name === 'AbortError') return; }
  }
  try{
    await navigator.clipboard.writeText(url);
    toast('Share link copied — send it to your group');
  } catch(_){
    prompt('Copy this link and send it to your group:', url);
  }
};

async function renderImport(payload){
  const box = $('importBody');
  showView('import');
  let incoming;
  try{ incoming = await decodeSplit(payload); }
  catch(_){ incoming = null; }
  if(!incoming || !incoming.id || !Array.isArray(incoming.entries)){
    box.innerHTML = `<div class="step-title">That link looks broken</div>
      <p class="hint">Ask whoever shared it to send the link again.</p>
      <a href="#/" class="btn-primary btn-link" style="padding:11px 20px;">Go home</a>`;
    return;
  }
  const existing = getSplit(incoming.id);
  const n = incoming.entries.filter(e => !e.deleted).length;
  box.innerHTML = `
    <div class="split-hero-type" style="color:var(--sage)">Shared ${escapeHtml(incoming.type || '')} split</div>
    <div class="step-title" style="font-size:28px;">${escapeHtml(incoming.name)}</div>
    <p class="hint" style="font-size:13.5px;">
      From ${escapeHtml(incoming.updatedBy || incoming.createdBy || 'someone')} · ${incoming.members.length} people · ${n} entr${n === 1 ? 'y' : 'ies'}
      ${incoming.location ? ` · 📍 ${escapeHtml(incoming.location)}` : ''}
    </p>
    <p class="hint">${existing
      ? 'You already have this split. Merging keeps every entry from both copies; where the same entry was edited, the newest edit wins.'
      : 'Save it to your splits, add your own expenses, then tap Share to send your updates back to the group.'}</p>
    <div class="form-actions">
      <button class="btn-primary" id="importBtn">${existing ? 'Merge updates' : 'Save to my splits'}</button>
      <a href="#/" class="btn-ghost btn-link" style="padding:11px 20px;">Cancel</a>
    </div>`;
  $('importBtn').onclick = () => {
    const merged = existing ? mergeSplits(existing, incoming) : incoming;
    splits[merged.id] = merged;
    persistSplits();
    toast(existing ? 'Updates merged' : 'Split saved');
    history.replaceState(null, '', `#/split/${encodeURIComponent(merged.id)}`);
    route();
  };
}

function mergeSplits(local, remote){
  const newer = (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
  const byId = {};
  local.entries.concat(remote.entries).forEach(e => {
    if(!byId[e.id] || (e.updatedAt || 0) > (byId[e.id].updatedAt || 0)) byId[e.id] = e;
  });
  const entries = Object.values(byId);
  return {
    ...newer,
    members: dedupe(local.members.concat(remote.members)),
    payModes: dedupe((local.payModes || []).concat(remote.payModes || [])),
    entries,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0)
  };
}

async function encodeSplit(split){
  const bytes = new TextEncoder().encode(JSON.stringify(split));
  if(window.CompressionStream){
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + toB64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'b' + toB64Url(bytes);
}
async function decodeSplit(payload){
  const kind = payload[0];
  let bytes = fromB64Url(payload.slice(1));
  if(kind === 'z'){
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if(kind !== 'b') throw new Error('bad payload');
  return JSON.parse(new TextDecoder().decode(bytes));
}
function toB64Url(bytes){
  let bin = '';
  for(let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(str){
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}

/* ---------------- GEOLOCATION ---------------- */
function captureGeo(btn, input, infoId, onGeo){
  if(!navigator.geolocation){ toast('Location is not available on this device'); return; }
  const orig = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  navigator.geolocation.getCurrentPosition(async pos => {
    const geo = { lat: round6(pos.coords.latitude), lng: round6(pos.coords.longitude) };
    onGeo(geo);
    renderGeoInfo(infoId, geo);
    if(!input.value.trim()){
      input.value = `${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}`;
      const place = await reverseGeocode(geo);
      if(place) input.value = place;
    }
    btn.textContent = orig; btn.disabled = false;
  }, err => {
    btn.textContent = orig; btn.disabled = false;
    toast(err.code === 1 ? 'Location permission denied' : 'Could not get your location');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

async function reverseGeocode({ lat, lng }){
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lng}`,
      { headers: { 'Accept-Language': navigator.language || 'en' } });
    if(!res.ok) return null;
    const j = await res.json();
    const a = j.address || {};
    const parts = [a.suburb || a.neighbourhood || a.village || a.town, a.city || a.county || a.state_district, a.state];
    return dedupe(parts.filter(Boolean)).slice(0, 2).join(', ') || j.display_name || null;
  } catch(_){ return null; }
}

function renderGeoInfo(id, geo){
  $(id).innerHTML = geo
    ? `📍 Pinned at ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)} · <a href="${mapUrl(geo)}" target="_blank" rel="noopener">view map</a> · <a href="#" data-clear-geo="${id}">remove pin</a>`
    : '';
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-clear-geo]');
  if(!a) return;
  e.preventDefault();
  if(a.dataset.clearGeo === 'splitGeoInfo') draftGeo = null; else entryGeo = null;
  renderGeoInfo(a.dataset.clearGeo, null);
});

function mapUrl(geo){ return `https://www.google.com/maps?q=${geo.lat},${geo.lng}`; }

/* ---------------- UTILS ---------------- */
function $(id){ return document.getElementById(id); }
function uid(prefix){ return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function round2(n){ return Math.round(n * 100) / 100; }
function round6(n){ return Math.round(n * 1e6) / 1e6; }
function formatNum(n){ return round2(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function cleanName(s){ return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40); }
function hasName(list, name){ return list.some(m => m.toLowerCase() === String(name).toLowerCase()); }
function dedupe(arr){ return Array.from(new Set(arr)); }
function initials(name){ return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'split'; }
function escapeHtml(str){ return String(str ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m])); }

function nowLocal(){
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function formatDateTime(local){
  if(!local) return ['—', ''];
  const d = new Date(local);
  if(isNaN(d)) return [escapeHtml(local), ''];
  return [
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  ];
}
function formatDay(ts){ return ts ? new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
function formatStamp(ts){ return ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''; }

/* ---------------- INIT ---------------- */
renderAuth();
route();
