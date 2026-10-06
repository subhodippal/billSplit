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
const DEFAULT_CURRENCY = '₹';   // existing splits keep whatever currency they were made with

function load(key, fallback){
  try{ const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch(_){ return fallback; }
}
function save(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }
  catch(_){ toast('Could not save — storage is full or blocked'); }
}

// Cloud mode (Supabase configured): accounts + shared, live splits.
// Otherwise: offline mode, everything lives in this browser.
const CLOUD = !!(window.Cloud && Cloud.enabled);
const IS_PWA = Store.isPWA;   // installed app: full offline copy in IndexedDB
const GUEST_NAME = 'Me';      // who "you" are before logging in; swapped for your name on sync

let user = CLOUD ? null : load(USER_KEY, null);    // {name, email, id?}
let splits = {};                                   // {id: split}
let cloudLoading = true;
let authReady = !CLOUD;

// Not logged in (or no Supabase): splits live only on this device.
function localMode(){ return !CLOUD || !user; }
function me(){ return user ? user.name : GUEST_NAME; }
function newId(prefix){ return CLOUD ? crypto.randomUUID() : uid(prefix); }

let cacheTimer;
function persistSplits(){
  if(!localMode()){
    // Logged in: the installed app keeps a copy of everything for offline use.
    if(!IS_PWA) return;
    clearTimeout(cacheTimer);
    const key = cacheKey(), data = splits;
    cacheTimer = setTimeout(() => Store.set(key, data).catch(() => {}), 300);
    return;
  }
  Store.set(SPLITS_KEY, splits).catch(() => toast('Could not save — storage is full or blocked'));
}
function cacheKey(){ return 'cache_' + user.id; }
function outboxKey(){ return 'outbox_' + user.id; }

/* --- saving changes --- */
// Each change is a small, replayable operation. Online it goes straight to
// Supabase; in the installed app it's queued while offline and sent later.
let outbox = [];
let syncing = false;

function isNetworkError(err){
  return !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test((err && err.message) || '');
}

function runOp(op){
  const s = getSplit(op.splitId);
  switch(op.type){
    case 'createSplit':   return s && Cloud.createSplit(s);
    case 'saveSplitMeta': return s && Cloud.saveSplitMeta(s);
    case 'addPerson':     return s && Cloud.addPerson(s, op.name);
    case 'renamePerson':  return s && Cloud.renamePerson(s, op.from, op.to);
    case 'removePerson':  return s && Cloud.removePerson(s, op.name);
    case 'saveEntry': {
      const en = s && s.entries.find(e => e.id === op.entryId);
      return en && Cloud.saveEntry(s, en);
    }
    case 'deleteEntry':   return Cloud.deleteEntry({ id: op.entryId });
    case 'deleteSplit':   return Cloud.deleteSplit({ id: op.splitId });
    case 'leaveSplit':    return Cloud.leaveSplit({ id: op.splitId });
  }
}

async function push(op){
  if(localMode()){ persistSplits(); return true; }
  // Keep order: once something is queued, later changes queue behind it.
  if(IS_PWA && (outbox.length || !navigator.onLine)){ queueOp(op); return true; }
  try{
    await runOp(op);
    persistSplits();
    return true;
  } catch(err){
    if(IS_PWA && isNetworkError(err)){ queueOp(op); return true; }
    toast(isNetworkError(err) ? 'You’re offline — that change wasn’t saved' : (err.message || 'Could not save'));
    if(op.splitId) await refreshSplit(op.splitId);
    return false;
  }
}

function queueOp(op){
  outbox.push(op);
  Store.set(outboxKey(), outbox).catch(() => {});
  persistSplits();
  renderStatusBar();
}

async function flushOutbox(){
  while(outbox.length){
    try{ await runOp(outbox[0]); }
    catch(err){
      if(isNetworkError(err)) throw err;   // still offline: keep the rest for later
      toast(`A change made offline couldn’t be saved: ${err.message}`);
    }
    outbox.shift();
    await Store.set(outboxKey(), outbox).catch(() => {});
    renderStatusBar();
  }
}

async function refreshSplit(id){
  try{
    const fresh = await Cloud.loadSplit(id);
    if(fresh) splits[id] = fresh; else delete splits[id];
  } catch(_){ /* offline — keep what we have */ }
  rerender(id);
}
function getSplit(id){ return splits[id] || null; }
function liveEntries(split){ return split.entries.filter(e => !e.deleted); }
function touch(obj){ obj.updatedAt = Date.now(); obj.updatedBy = me(); }

/* ---------------- AUTH ---------------- */
let afterLogin = null;

function renderAuth(){
  const area = $('authArea');
  if(user){
    area.innerHTML = `
      <div class="user-pill">
        <button class="user-avatar" id="avatarBtn" title="Change your name">${user.avatar
          ? `<img src="${escapeHtml(user.avatar)}" alt="" referrerpolicy="no-referrer" data-i="${escapeHtml(initials(user.name))}" onerror="this.replaceWith(this.dataset.i)">`
          : escapeHtml(initials(user.name))}</button>
        <span class="user-name">${escapeHtml(user.name)}</span>
        <button class="logout-btn" id="logoutBtn" title="Log out">⎋ Log out</button>
      </div>`;
    $('avatarBtn').onclick = changeMyName;
    $('logoutBtn').onclick = async () => {
      const pending = CLOUD ? outbox.length : 0;
      const msg = !CLOUD ? 'Log out? Your splits stay saved on this device.'
        : pending ? `You have ${pending} change${pending > 1 ? 's' : ''} that haven’t synced yet — they’ll be lost if you log out now. Log out anyway?`
        : 'Log out of SplitEasy on this device?';
      if(!confirm(msg)) return;
      if(CLOUD){
        const id = user.id;
        try{ await Cloud.signOut(); } catch(err){ toast(err.message); }
        // Don't leave your account's offline copy behind on this device.
        await Store.del('cache_' + id);
        await Store.del('outbox_' + id);
        await Store.del('last_user');
        await onSignedOut();
        return;
      }
      localStorage.removeItem(USER_KEY);
      user = null;
      renderAuth();
      route();
    };
  } else {
    area.innerHTML = `<button class="btn-primary btn-small" id="loginBtn">Log in</button>`;
    $('loginBtn').onclick = () => openLogin();
  }
}

async function changeMyName(){
  const input = prompt('Your name (shown on entries you add):', user.name);
  const name = cleanName(input || '');
  if(!name || name === user.name) return;
  if(CLOUD){
    try{ await Cloud.updateName(name); } catch(err){ toast(err.message); return; }
  } else {
    save(USER_KEY, { ...user, name });
  }
  user = { ...user, name };
  renderAuth();
  toast('Name updated — rename yourself in a split’s People list if needed');
}

function showLoginMsg(msg, isError){
  $('loginMsg').hidden = !msg;
  $('loginMsg').textContent = msg;
  $('loginMsg').classList.toggle('error', !!isError);
}

function openLogin(then){
  afterLogin = then || null;
  $('loginGoogle').hidden = !CLOUD;
  $('loginForm').hidden = CLOUD;
  if(!CLOUD){
    $('loginName').value = user ? user.name : '';
    $('loginEmail').value = user ? (user.email || '') : '';
  }
  showLoginMsg('');
  $('googleBtn').disabled = false;
  openSheet('loginSheet');
  if(!CLOUD) setTimeout(() => $('loginName').focus(), 50);
}

function requireLogin(then){
  if(user){ then(); return; }
  toast('Log in to continue');
  openLogin(then);
}

function finishLogin(){
  closeSheet('loginSheet');
  renderAuth();
  toast(`Welcome, ${user.name}!`);
  const next = afterLogin; afterLogin = null;
  if(next) next(); else route();
}

// Offline mode only: no accounts, just a name.
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = cleanName($('loginName').value);
  if(!name) return;
  user = { name, email: $('loginEmail').value.trim() };
  save(USER_KEY, user);
  // Splits made before logging in become yours.
  Object.keys(splits).forEach(id => { splits[id] = adoptGuestSplit(splits[id], name); });
  persistSplits();
  finishLogin();
});

// Swap the "Me" placeholder for your real name everywhere in a split.
function adoptGuestSplit(split, name){
  const swap = n => n === GUEST_NAME ? name : n;
  const s = JSON.parse(JSON.stringify(split));
  s.members = dedupe(s.members.map(swap));
  s.createdBy = swap(s.createdBy);
  s.updatedBy = swap(s.updatedBy);
  s.entries.forEach(e => {
    e.paidBy = swap(e.paidBy);
    e.addedBy = swap(e.addedBy);
    e.updatedBy = swap(e.updatedBy);
    e.splitAmong = dedupe(e.splitAmong.map(swap));
  });
  return s;
}

// Google sign-in leaves the page and comes back to the site root signed in;
// onAuthStateChange → onSignedIn() then returns to the remembered screen.
$('googleBtn').onclick = async function(){
  this.disabled = true;
  showLoginMsg('');
  rememberReturn();
  try{ await Cloud.signInWithGoogle(); }
  catch(err){
    this.disabled = false;
    showLoginMsg(/provider is not enabled/i.test(err.message)
      ? 'Google sign-in isn’t switched on for this app yet.'
      : err.message, true);
  }
};

// Sign-in redirects land on the site root; remember where to go back to afterwards.
const RETURN_KEY = 'se_return';
function rememberReturn(){ try{ localStorage.setItem(RETURN_KEY, location.hash || '#/'); } catch(_){} }
function takeReturn(){
  try{ const h = localStorage.getItem(RETURN_KEY); localStorage.removeItem(RETURN_KEY); return h; }
  catch(_){ return null; }
}

/* ---------------- SHEETS / TOAST ---------------- */
function openSheet(id){ $(id).hidden = false; document.body.classList.add('no-scroll'); }
function closeSheet(id){
  $(id).hidden = true;
  if(id === 'confirmSheet' && confirmResolve) settleConfirm(false);   // ✕, backdrop or Esc = cancel
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
let currentView = 'home';
function showView(name, keepScroll){
  const changed = currentView !== name;
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelector('footer.foot').hidden = name !== 'home';
  // Header back button goes one level up: split -> all splits -> home.
  const up = { splits: '#/', split: '#/splits', import: '#/',
    new: editingSplitId ? `#/split/${encodeURIComponent(editingSplitId)}` : '#/' }[name];
  $('topBack').hidden = !up;
  if(up) $('topBack').href = up;
  if(!keepScroll || changed) window.scrollTo(0, 0);
}

function route(){
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  const arg = rest.join('/');
  document.querySelectorAll('.sheet-backdrop:not([hidden])').forEach(s => closeSheet(s.id));

  if(page === 'join' && arg) return renderJoin(arg);
  if(cloudLoading && ['split', 'edit'].includes(page)) return renderLoading();
  // A split made before logging in gets a new id once it's uploaded.
  if(page === 'split' && !getSplit(arg) && idRemap[arg]) return location.replace(`#/split/${encodeURIComponent(idRemap[arg])}`);
  if(page === 'splits') return renderSplitList();
  if(page === 'new') return renderSplitForm(null);
  if(page === 'edit' && getSplit(arg)) return renderSplitForm(arg);
  if(page === 'split' && getSplit(arg)) return renderSplitDetail(arg);
  if(page === 'import' && arg) return renderImport(arg);
  if(page && page !== '') { location.hash = '#/'; return; }
  renderHome();
}
window.addEventListener('hashchange', route);

function renderLoading(){
  $('splitList').innerHTML = '<div class="loading-note">Loading your splits…</div>';
  showView('splits');
}

/* ---------------- HOME ---------------- */
function renderHome(){
  const count = Object.keys(splits).length;
  $('homeGreeting').textContent = user ? `Hey ${user.name}, split it fairly.` : 'Split every bill, fairly.';
  $('homeSplitCount').textContent = count ? `${count} split${count > 1 ? 's' : ''} saved →` : 'Nothing yet — create your first one';
  showView('home');
}

/* ---------------- SPLIT LIST ---------------- */
/* --- favourites (kept on this device) --- */
const FAV_KEY = 'se_favs';
let favourites = new Set(load(FAV_KEY, []));
function isFavourite(id){ return favourites.has(id); }
function setFavourite(id, on){
  if(on) favourites.add(id); else favourites.delete(id);
  save(FAV_KEY, [...favourites]);
}

// Star / delete buttons sit inside the card link, so stop them from opening the split.
$('splitList').addEventListener('click', e => {
  const fav = e.target.closest('[data-fav]');
  const del = e.target.closest('[data-del]');
  if(!fav && !del) return;
  e.preventDefault();
  e.stopPropagation();
  if(fav){
    const on = !isFavourite(fav.dataset.fav);
    setFavourite(fav.dataset.fav, on);
    toast(on ? '★ Added to favourites' : 'Removed from favourites');
    renderSplitList(true);
  } else {
    deleteSplitAsk(del.dataset.del);
  }
});

function renderSplitList(keepScroll){
  if(cloudLoading){ renderLoading(); return; }
  // Favourites first, then most recently changed.
  const list = Object.values(splits).sort((a, b) => (isFavourite(b.id) - isFavourite(a.id)) || (b.updatedAt - a.updatedAt));
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
      const fav = isFavourite(s.id);
      const leaving = !localMode() && s.role !== 'owner';
      return `<a class="split-card ${fav ? 'is-fav' : ''}" href="#/split/${encodeURIComponent(s.id)}">
        <div class="split-card-top">
          <span class="tag">${escapeHtml(s.type)}</span>
          <span class="hint" style="margin:0;">${s.collaborators > 1 ? `👥 shared · ` : ''}${formatDay(s.createdAt)}</span>
          <span class="card-actions">
            <button type="button" class="card-btn fav-btn ${fav ? 'on' : ''}" data-fav="${s.id}" title="${fav ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${fav}">${fav ? '★' : '☆'}</button>
            <button type="button" class="card-btn del-btn" data-del="${s.id}" title="${leaving ? 'Leave split' : 'Delete split'}">🗑</button>
          </span>
        </div>
        <div class="split-card-name">${escapeHtml(s.name)}</div>
        ${s.location ? `<div class="split-card-loc">📍 ${escapeHtml(s.location)}</div>` : ''}
        <div class="split-card-foot">
          <span>${s.members.length} ${s.members.length === 1 ? 'person' : 'people'} · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
          <span class="split-card-total">${escapeHtml(s.currency)}${formatNum(spent)}</span>
        </div>
      </a>`;
    }).join('');
  }
  showView('splits', keepScroll);
}

/* ---------------- CREATE / EDIT SPLIT ---------------- */
let draftMembers = [];
let draftGeo = null;
let editingSplitId = null;

function renderSplitForm(splitId){
  editingSplitId = splitId;
  const s = splitId ? getSplit(splitId) : null;
  $('newTitle').textContent = s ? 'Edit details' : 'New split';
  $('splitSubmitBtn').textContent = s ? 'Save changes' : 'Create split →';
  $('splitName').value = s ? s.name : '';
  $('splitType').value = s ? s.type : 'Travel';
  $('splitLocation').value = s ? (s.location || '') : '';
  draftGeo = s ? s.geo : null;
  renderGeoInfo('splitGeoInfo', draftGeo);
  // Members are managed on the split page once it exists
  document.querySelectorAll('#splitForm .perf, #splitForm .perf ~ .step-head, #splitForm .perf ~ .step-desc, #splitForm .add-inline, #memberChips')
    .forEach(el => el.style.display = s ? 'none' : '');
  draftMembers = [me()];
  renderDraftMembers();
  showView('new');
}

function renderDraftMembers(){
  $('memberChips').innerHTML = draftMembers.map(m => `
    <div class="chip"><span class="avatar-dot"></span><span>${escapeHtml(m)}</span>
      ${m === me() ? '<span class="you">YOU</span>&nbsp;' :
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
attachPlaceSuggest($('splitLocation'), {
  onPick: g => { draftGeo = g; renderGeoInfo('splitGeoInfo', g); },
  onType: () => { draftGeo = null; renderGeoInfo('splitGeoInfo', null); }
});

$('splitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('splitName').value.trim();
  if(!name){ $('splitName').focus(); return; }
  // pick up a name typed but not yet added
  if($('memberInput').value.trim()) addDraftMember();

  if(editingSplitId){
    const s = getSplit(editingSplitId);
    Object.assign(s, {
      name, type: $('splitType').value,
      location: $('splitLocation').value.trim(), geo: draftGeo
    });
    touch(s);
    await push({ type: 'saveSplitMeta', splitId: s.id });
    toast('Details saved');
    location.hash = `#/split/${encodeURIComponent(s.id)}`;
    return;
  }

  const now = Date.now();
  const s = {
    id: newId('s'),
    name,
    type: $('splitType').value,
    currency: DEFAULT_CURRENCY,
    location: $('splitLocation').value.trim(),
    geo: draftGeo,
    members: draftMembers.slice(),
    payModes: DEFAULT_PAY_MODES.slice(),
    entries: [],
    createdBy: me(),
    createdAt: now,
    updatedAt: now,
    updatedBy: me()
  };
  if(!localMode()) Object.assign(s, { cloud: true, role: 'owner', collaborators: 1 });
  splits[s.id] = s;
  const btn = $('splitSubmitBtn');
  btn.disabled = true;
  const ok = await push({ type: 'createSplit', splitId: s.id });
  btn.disabled = false;
  if(!ok){ delete splits[s.id]; return; }
  // Pick up server-made fields (invite code) once it's really saved.
  if(!localMode() && !outbox.length) refreshSplit(s.id);
  $('memberInput').value = '';
  toast('Split created');
  location.hash = `#/split/${encodeURIComponent(s.id)}`;
});

/* ---------------- SPLIT DETAIL ---------------- */
let currentSplitId = null;
let editMode = false;   // splits open read-only; tap Edit to change anything
function cur(){ return getSplit(currentSplitId); }

function setEditMode(on){
  editMode = on;
  $('view-split').classList.toggle('editing', on);
  $('modeBtn').textContent = on ? '✓ Done' : '✎ Edit';
  $('modeBtn').classList.toggle('btn-done', on);
  $('entryEmpty').innerHTML = on
    ? 'No entries yet. Tap <strong>＋ Add entry</strong> to log the first expense.'
    : 'No entries yet. Tap <strong>✎ Edit</strong> to start adding expenses.';
}
$('modeBtn').onclick = () => {
  const toggle = on => { setEditMode(on); if(cur()) renderMembers(); };
  toggle(!editMode);
};

function renderSplitDetail(id, keepScroll){
  // Back to view mode when opening another split or arriving from outside it
  // (returning from "Details" keeps you editing).
  const opening = id !== currentSplitId || !['split', 'new'].includes(currentView);
  if(opening) setEditMode(false);
  currentSplitId = id;
  const s = cur();
  if(opening) loadAvatars(s);
  $('detailName').textContent = s.name;
  // Travel | 6 Oct 2026 | 4 people | 📍 Purulia, West Bengal
  const meta = [
    `<span class="meta-type">${escapeHtml(s.type)}</span>`,
    `<span>${formatDay(s.createdAt)}</span>`,
    `<span>${s.members.length} ${s.members.length === 1 ? 'person' : 'people'}</span>`
  ];
  if(s.location){
    meta.push(s.geo
      ? `<a href="${mapUrl(s.geo)}" target="_blank" rel="noopener">📍 ${escapeHtml(s.location)}</a>`
      : `<span>📍 ${escapeHtml(s.location)}</span>`);
  } else if(s.geo){
    meta.push(`<a href="${mapUrl(s.geo)}" target="_blank" rel="noopener">📍 ${s.geo.lat.toFixed(4)}, ${s.geo.lng.toFixed(4)}</a>`);
  }
  if(CLOUD && s.collaborators > 1) meta.push(`<span>🔗 Shared with ${s.collaborators - 1}</span>`);
  meta.push(`<span class="live-dot" id="liveDot" title="Live — updates from your group appear instantly" ${CLOUD && liveStatus === 'SUBSCRIBED' ? '' : 'hidden'}>● LIVE</span>`);
  $('detailMeta').innerHTML = meta.join('');
  renderMembers();
  renderEntries();
  renderSettlement();
  showView('split', keepScroll);
}

/* --- members --- */
function renderMembers(){
  const s = cur();
  $('detailMembers').innerHTML = s.members.map(m => `
    <div class="chip person-chip" data-tip="${escapeHtml(m)}" title="${escapeHtml(m)}">
      ${personAvatar(m)}
      <button type="button" class="chip-name" data-rename="${escapeHtml(m)}">${escapeHtml(m)}</button>
      ${m === me() ? '<span class="you">YOU</span>' : ''}
      <button type="button" class="chip-x edit-only" data-remove="${escapeHtml(m)}" title="Remove">×</button>
    </div>`).join('') || `<span class="hint">No one yet${editMode ? ' — add people below' : ''}.</span>`;
}

// Phones, view mode: 👁 shows everyone's name under their photo.
$('peopleToggle').onclick = function(){
  const open = this.closest('.people-card').classList.toggle('names-open');
  this.setAttribute('aria-pressed', open);
  this.title = open ? 'Hide names' : 'Show names';
  hideTips();
};

/* --- profile photos --- */
let splitAvatars = {};   // lower-cased name -> photo URL, for the open split

async function loadAvatars(s){
  splitAvatars = {};
  if(!CLOUD || !user) return;
  try{ splitAvatars = await Cloud.splitAvatars(s); }
  catch(_){ return; }   // photos are a nice-to-have
  if(currentSplitId === s.id && currentView === 'split'){ renderMembers(); renderEntries(); }
}

function avatarUrlFor(name){
  if(user && user.avatar && name === user.name) return user.avatar;
  return splitAvatars[name.toLowerCase()] || '';
}

// Photo if we have one, otherwise the first letter on a colour picked from the name.
// The letter sits underneath, so a photo that fails to load falls back to it.
function personAvatar(name){
  const url = avatarUrlFor(name);
  let hash = 0;
  for(const ch of name) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return `<span class="p-avatar" style="--hue:${hash}">${escapeHtml(name.trim().charAt(0).toUpperCase())}${url
    ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
}

// Phones show photos only (in view mode); tap one to see the name.
let tipTimer;
function hideTips(){ document.querySelectorAll('.person-chip.tip').forEach(c => c.classList.remove('tip')); }
document.addEventListener('click', e => {
  const chip = !editMode && !document.querySelector('.people-card.names-open') && e.target.closest('#detailMembers .person-chip');
  const wasOpen = chip && chip.classList.contains('tip');
  hideTips();
  clearTimeout(tipTimer);
  if(chip && !wasOpen){
    chip.classList.add('tip');
    tipTimer = setTimeout(hideTips, 2500);
  }
});

function addMember(split, rawName){
  const name = cleanName(rawName);
  if(!name) return null;
  const existing = split.members.find(m => m.toLowerCase() === name.toLowerCase());
  if(existing) return existing;
  split.members.push(name);
  touch(split);
  return name;
}

// Add any names not yet in the split (locally right away, then on the server).
async function ensurePeople(s, names){
  const fresh = names.map(cleanName).filter(n => n && !hasName(s.members, n));
  dedupe(fresh).forEach(n => addMember(s, n));
  if(localMode()){ if(fresh.length) persistSplits(); return true; }
  for(const n of dedupe(fresh)){
    if(!await push({ type: 'addPerson', splitId: s.id, name: n })) return false;
  }
  return true;
}

async function addDetailMember(){
  const s = cur();
  const name = cleanName($('detailMemberInput').value);
  if(!name) return;
  if(hasName(s.members, name)){ toast(`${name} is already in the group`); return; }
  $('detailMemberInput').value = '';
  const added = name;
  if(!await ensurePeople(s, [name])) return;
  renderSplitDetail(s.id);
  toast(`${added} added — included in new entries from now on`);
}
$('detailMemberAddBtn').onclick = addDetailMember;
$('detailMemberInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); addDetailMember(); } });

$('detailMembers').addEventListener('click', (e) => {
  if(!editMode) return;
  const s = cur();
  const ren = e.target.closest('[data-rename]');
  const rem = e.target.closest('[data-remove]');
  if(ren) renameMember(s, ren.dataset.rename);
  if(rem) removeMember(s, rem.dataset.remove);
});

async function renameMember(s, oldName){
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
  renderSplitDetail(s.id, true);
  if(await push({ type: 'renamePerson', splitId: s.id, from: oldName, to: target })) toast(`Renamed to ${target} everywhere`);
}

async function removeMember(s, name){
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
  renderSplitDetail(s.id, true);
  await push({ type: 'removePerson', splitId: s.id, name });
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
    return `<tr class="row-${signCls}" data-id="${e.id}">
      <td class="cell-date c-date" data-label="Date">${d}<small>${t}</small></td>
      <td class="num c-amount" data-label="Amount"><span class="amt ${signCls}">${e.sign < 0 ? '−' : '+'}${c}${formatNum(e.amount)}</span></td>
      <td class="c-purpose" data-label="Purpose"><span class="purpose-wrap" data-full="${escapeHtml(e.purpose)}">${personAvatar(e.paidBy)}<span class="purpose-text" title="${escapeHtml(e.purpose)}">${escapeHtml(e.purpose)}</span></span></td>
      <td class="c-via ${e.payVia ? '' : 'c-empty'}" data-label="Via">${escapeHtml(e.payVia || '—')}</td>
      <td class="c-by" data-label="Paid by">${escapeHtml(e.paidBy)}${onBehalf ? `<span class="sub">added by ${escapeHtml(e.addedBy)}</span>` : ''}</td>
      <td class="cell-note c-note ${e.note ? '' : 'c-empty'}" data-label="Note">${escapeHtml(e.note || '—')}</td>
      <td class="c-split" data-label="Split">${everyone ? '<span class="split-all">Everyone</span>' : `${e.splitAmong.length} of ${s.members.length}`}
        ${everyone ? '' : `<span class="excl-note">excl. <span class="excl-names">${excluded.map(escapeHtml).join(', ')}</span></span>`}</td>
      <td class="c-m c-meta">${[escapeHtml(e.paidBy), e.payVia && escapeHtml(e.payVia), shortWhen(e.datetime) && `<span class="m-when">${shortWhen(e.datetime)}</span>`]
        .filter(Boolean).map(x => x.startsWith('<span') ? x : `<span>${x}</span>`).join('')}</td>
      <td class="c-m c-noteicon">${e.note ? `<button type="button" class="note-btn" data-stop data-note="${escapeHtml(e.note)}" aria-label="Show note">📝</button>` : ''}</td>
      <td class="cell-actions edit-only">
        <button class="btn-icon" title="Edit" data-edit="${e.id}">✏️</button>
        <button class="btn-icon" title="Delete" data-delete="${e.id}">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// "06 Oct · 10:15 pm" (year only when it isn't this year) for the compact phone cards.
function shortWhen(local){
  const d = new Date(local);
  if(!local || isNaN(d)) return '';
  const opts = { day: '2-digit', month: 'short' };
  if(d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString('en-IN', opts)} · ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}

// Tap the 📝 on an entry to see its note; tap a cut-off purpose ("…") to see all of it.
document.addEventListener('click', e => {
  const btn = e.target.closest('.note-btn');
  let wrap = !btn && !editMode && e.target.closest('#entryBody .purpose-wrap');
  if(wrap){
    const text = wrap.querySelector('.purpose-text');
    if(text.scrollWidth <= text.clientWidth) wrap = null;   // already fully visible
  }
  const target = btn || wrap;
  document.querySelectorAll('.note-btn.open, .purpose-wrap.open').forEach(b => { if(b !== target) b.classList.remove('open'); });
  if(target) target.classList.toggle('open');
});

$('entryBody').addEventListener('click', (e) => {
  if(e.target.closest('[data-stop]') || !editMode) return;
  const del = e.target.closest('[data-delete]');
  if(del){ deleteEntry(del.dataset.delete); return; }
  const row = e.target.closest('tr[data-id]');
  if(row) openEntrySheet(row.dataset.id);
});

async function deleteEntry(id){
  const s = cur();
  const en = s.entries.find(x => x.id === id);
  if(!en || !confirm(`Delete "${en.purpose}"?`)) return;
  if(!localMode()){
    s.entries = s.entries.filter(x => x.id !== id);
  } else {
    en.deleted = true;            // tombstone so the deletion syncs via share links
    touch(en); touch(s);
  }
  closeSheet('entrySheet');
  renderSplitDetail(s.id, true);
  if(await push({ type: 'deleteEntry', splitId: s.id, entryId: id })) toast('Entry deleted');
}

/* ---------------- ENTRY SHEET ---------------- */
let editingEntryId = null;
let entrySign = -1;

$('addEntryBtn').onclick = () => openEntrySheet(null);

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
  $('eNote').value = en ? (en.note || '') : '';

  // Paid by defaults to the logged-in user (who may be new to a shared split)
  fillPaidBy(en ? en.paidBy : me());
  fillPayVia(en ? en.payVia : (lastPayVia(s) || s.payModes[0]));
  renderSplitPills(en ? en.splitAmong : s.members.concat(hasName(s.members, me()) ? [] : [me()]));
  $('purposeList').innerHTML = dedupe(liveEntries(s).map(x => x.purpose)).map(p => `<option value="${escapeHtml(p)}">`).join('');

  $('eAddedBy').innerHTML = en
    ? `Added by <strong>${escapeHtml(en.addedBy || '—')}</strong> · ${formatStamp(en.createdAt)}` +
      (en.updatedBy && en.updatedAt !== en.createdAt ? ` &nbsp;·&nbsp; last edited by <strong>${escapeHtml(en.updatedBy)}</strong> · ${formatStamp(en.updatedAt)}` : '')
    : `Will be added by <strong>${escapeHtml(me())}</strong>. Paying on behalf of someone? Just change <em>Paid by</em>.`;

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
  if(!hasName(names, me())) names.push(me());
  if(selected && !names.includes(selected)) names.push(selected);
  fillSelect($('ePaidBy'), names, selected, '＋ Add new person…', n => n === me() ? `${n} (you)` : n);
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

$('ePaidBy').addEventListener('change', async function(){
  if(this.value !== NEW_OPTION){ this.dataset.prev = this.value; return; }
  const name = cleanName(prompt('Name of the person who paid:') || '');
  if(!name){ this.value = this.dataset.prev; return; }
  const s = cur();
  const added = s.members.find(m => m.toLowerCase() === name.toLowerCase()) || name;
  const checked = getCheckedSplit();
  if(!await ensurePeople(s, [added])) return;
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
  fillPayVia(existing || mode);
  if(!existing){ s.payModes.push(mode); touch(s); push({ type: 'saveSplitMeta', splitId: s.id }); }
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

$('eDeleteBtn').onclick = () => deleteEntry(editingEntryId);

$('entryForm').addEventListener('submit', async (e) => {
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
  const btn = $('eSubmitBtn');
  btn.disabled = true;
  try{
    if(!await ensurePeople(s, [paidBy, ...splitAmong])) return;
    await saveEntryFromForm(s, { paidBy, payVia, purpose, amount, splitAmong });
  } finally {
    btn.disabled = false;
  }
});

async function saveEntryFromForm(s, { paidBy, payVia, purpose, amount, splitAmong }){
  const data = {
    datetime: $('eDate').value || nowLocal(),
    amount: round2(amount),
    sign: entrySign,
    purpose, payVia, paidBy,
    location: '',   // entries don't keep a location (the split has one)
    geo: null,
    note: $('eNote').value.trim(),
    splitAmong
  };

  let en = editingEntryId && s.entries.find(x => x.id === editingEntryId);
  if(en){
    Object.assign(en, data);
    touch(en);
  } else {
    const now = Date.now();
    en = { id: newId('e'), ...data, addedBy: me(), createdAt: now, updatedAt: now, updatedBy: me() };
    s.entries.push(en);
  }
  touch(s);
  const isEdit = !!editingEntryId;
  closeSheet('entrySheet');
  renderSplitDetail(s.id, true);
  if(await push({ type: 'saveEntry', splitId: s.id, entryId: en.id })) toast(isEdit ? 'Entry updated' : 'Entry added');
}

function lastEntry(s){ return sortedEntries(s).slice(-1)[0]; }
function lastPayVia(s){ const l = lastEntry(s); return l && l.payVia; }

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
    // Per-person rounding can leave a paisa of drift; settle what the debtor actually owes.
    const amt = Math.abs(c.amt - d.amt) <= 0.02 ? d.amt : Math.min(c.amt, d.amt);
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
    const label = b > 0.005 ? 'gets back' : (b < -0.005 ? 'owes' : '');
    // Name over "paid · share" on the left; label over amount on the right.
    return `<div class="person-row">
      <div class="person-left">
        <span class="person-name">${escapeHtml(p)}${user && p === me() ? ' <span class="you">YOU</span>' : ''}</span>
        <span class="person-sub">${personSummary(entries, p, c)} · share ${c}${formatNum(share[p])}</span>
      </div>
      <div class="person-bal ${cls}">${label
        ? `<small>${label}</small><b>${c}${formatNum(Math.abs(b))}</b>`
        : '<b>✓ settled</b>'}</div>
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


$('editDetailsBtn').onclick = () => { location.hash = `#/edit/${encodeURIComponent(currentSplitId)}`; };

/* --- delete / leave (from the splits list) --- */
async function deleteSplitAsk(id){
  const s = getSplit(id);
  if(!s) return;
  const leaving = !localMode() && s.role !== 'owner';
  const ok = await confirmDialog({
    icon: leaving ? '🚪' : '🗑️',
    title: leaving ? 'Leave this split?' : 'Delete this split?',
    message: leaving
      ? `You'll lose access to <strong>${escapeHtml(s.name)}</strong> until someone shares it with you again.`
      : `<strong>${escapeHtml(s.name)}</strong>${(n => n ? ` and its ${n} entr${n === 1 ? 'y' : 'ies'}` : '')(liveEntries(s).length)} will be deleted${!localMode() && s.collaborators > 1 ? ' for <strong>everyone</strong> it’s shared with' : ''}. This can’t be undone.`,
    confirmLabel: leaving ? 'Leave split' : 'Delete split'
  });
  if(!ok) return;
  if(!localMode() && !await push({ type: leaving ? 'leaveSplit' : 'deleteSplit', splitId: s.id })) return;
  delete splits[s.id];
  setFavourite(s.id, false);
  persistSplits();
  toast(leaving ? 'You left the split' : 'Split deleted');
  rerender();
}

// Promise-based confirm popup: resolves true on confirm, false on cancel / close.
let confirmResolve = null;
function confirmDialog({ icon, title, message, confirmLabel }){
  if(confirmResolve) confirmResolve(false);
  $('confirmIcon').textContent = icon || '⚠️';
  $('confirmTitle').textContent = title;
  $('confirmMessage').innerHTML = message;
  $('confirmOkBtn').textContent = confirmLabel || 'Confirm';
  openSheet('confirmSheet');
  setTimeout(() => $('confirmCancelBtn').focus(), 50);
  return new Promise(resolve => { confirmResolve = resolve; });
}
function settleConfirm(result){
  const r = confirmResolve;
  confirmResolve = null;
  if(!$('confirmSheet').hidden) closeSheet('confirmSheet');
  if(r) r(result);
}
$('confirmOkBtn').onclick = () => settleConfirm(true);
$('confirmCancelBtn').onclick = () => settleConfirm(false);

/* ---------------- SHARE / IMPORT ---------------- */
// No server: the whole split travels inside the link. Whoever opens it gets a
// copy; when they share back, entries are merged by id (newest edit wins).
$('shareBtn').onclick = async () => {
  const s = cur();
  if(CLOUD && !user){ toast('Log in to share — this split comes with you'); openLogin(); return; }
  if(CLOUD){
    if(!s.shareCode){ toast('Connect to the internet to share this split'); return; }
    openShareSheet(s);
    return;
  }
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
  const existing = CLOUD ? null : getSplit(incoming.id);
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
  if(CLOUD){
    $('importBtn').textContent = 'Save to my account';
    $('importBtn').onclick = () => requireLogin(async () => {
      try{
        const saved = await Cloud.uploadSplit(incoming);
        splits[saved.id] = saved;
        toast('Split saved to your account');
        history.replaceState(null, '', `#/split/${encodeURIComponent(saved.id)}`);
        route();
      } catch(err){ toast(err.message); }
    });
    return;
  }
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
  draftGeo = null;
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

/* ---------------- CLOUD: SHARE SHEET ---------------- */
function joinUrl(s){ return `${location.origin}${location.pathname}#/join/${s.shareCode}`; }

async function openShareSheet(s){
  $('shareLink').value = joinUrl(s);
  $('shareLinkBtn').textContent = navigator.share ? 'Share' : 'Copy';
  $('shareLinkHint').innerHTML = `Anyone with this link can join after signing in.` +
    (s.role === 'owner' ? ` <button type="button" class="btn-link-text" id="resetLinkBtn">Reset link</button>` : '');
  if($('resetLinkBtn')) $('resetLinkBtn').onclick = async () => {
    if(!confirm('Make a new invite link? The old link stops working (people who already joined keep access).')) return;
    try{ s.shareCode = await Cloud.resetShareCode(s); $('shareLink').value = joinUrl(s); toast('New link ready'); }
    catch(err){ toast(err.message); }
  };
  openSheet('shareSheet');
  renderCollaborators(s);
}

async function renderCollaborators(s){
  const box = $('collabList');
  let data;
  try{ data = await Cloud.collaborators(s); }
  catch(err){ box.innerHTML = `<div class="hint">${escapeHtml(err.message)}</div>`; return; }
  s.collaborators = data.members.length;
  const isOwner = s.role === 'owner';
  box.innerHTML = data.members.map(m => `
    <div class="collab-row">
      <span class="user-avatar">${escapeHtml(initials(m.name || m.email || '?'))}</span>
      <span class="who">${escapeHtml(m.name || m.email)}${m.userId === user.id ? ' (you)' : ''}<small>${escapeHtml(m.email || '')}</small></span>
      <span class="role">${m.role}</span>
      ${isOwner && m.userId !== user.id ? `<button class="btn-icon" data-remove-user="${m.userId}" title="Remove access">✕</button>` : ''}
    </div>`).join('') + data.invites.map(email => `
    <div class="collab-row">
      <span class="user-avatar" style="background:var(--paper-dim)">✉</span>
      <span class="who">${escapeHtml(email)}<small>Invited — joins when they sign up</small></span>
      <button class="btn-icon" data-cancel-invite="${escapeHtml(email)}" title="Cancel invite">✕</button>
    </div>`).join('');
}

$('collabList').addEventListener('click', async e => {
  const s = cur();
  const rm = e.target.closest('[data-remove-user]');
  const ci = e.target.closest('[data-cancel-invite]');
  try{
    if(rm){
      if(!confirm('Remove this person’s access to the split?')) return;
      await Cloud.removeCollaborator(s, rm.dataset.removeUser);
    } else if(ci){
      await Cloud.cancelInvite(s, ci.dataset.cancelInvite);
    } else return;
    renderCollaborators(s);
  } catch(err){ toast(err.message); }
});

$('inviteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const s = cur();
  const email = $('inviteEmail').value.trim();
  try{
    const result = await Cloud.invite(s, email);
    $('inviteEmail').value = '';
    toast(result === 'added' ? `${email} now has access` : `Invite saved — send them the link so they can sign up`);
    renderCollaborators(s);
  } catch(err){ toast(err.message); }
});

$('shareLinkBtn').onclick = async () => {
  const s = cur();
  const url = joinUrl(s);
  if(navigator.share){
    try{ await navigator.share({ title: `SplitEasy · ${s.name}`, text: `Join "${s.name}" on SplitEasy and add your expenses:`, url }); return; }
    catch(err){ if(err.name === 'AbortError') return; }
  }
  try{ await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch(_){ $('shareLink').select(); document.execCommand('copy'); toast('Invite link copied'); }
};

/* ---------------- CLOUD: JOIN LINK ---------------- */
function renderJoin(code){
  const box = $('importBody');
  showView('import');
  if(!CLOUD){
    box.innerHTML = `<div class="step-title">Online sharing isn't set up</div>
      <p class="hint">This copy of SplitEasy isn't connected to a database, so invite links don't work here.</p>
      <a href="#/" class="btn-primary btn-link" style="padding:11px 20px;">Go home</a>`;
    return;
  }
  box.innerHTML = `<div class="split-hero-type" style="color:var(--sage)">You're invited</div>
    <div class="step-title" style="font-size:26px;">Join a shared split</div>
    <p class="hint" style="font-size:13.5px;">Sign in or create an account to see the split and add your expenses. Everyone sees changes live.</p>
    <div class="form-actions"><button class="btn-primary" id="joinBtn">${user ? 'Join split' : 'Sign in to join'}</button></div>`;
  const join = async () => {
    try{
      const id = await Cloud.joinByCode(code);
      const s = await Cloud.loadSplit(id);
      if(s) splits[id] = s;
      toast('You joined the split');
      history.replaceState(null, '', `#/split/${encodeURIComponent(id)}`);
      route();
    } catch(err){ toast(err.message); }
  };
  $('joinBtn').onclick = () => requireLogin(join);
  if(user && !cloudLoading) join();
}

/* ---------------- SYNC: DEVICE ⇄ ACCOUNT ---------------- */
const idRemap = {};   // guest split id -> id it got in your account

// Splits made before logging in move into your account automatically.
async function uploadGuestSplits(){
  const local = await Store.get(SPLITS_KEY, {});
  const list = Object.values(local);
  if(!list.length) return;
  let moved = 0;
  for(const ls of list){
    try{
      const saved = await Cloud.uploadSplit(adoptGuestSplit(ls, user.name));
      idRemap[ls.id] = saved.id;
      if(isFavourite(ls.id)){ setFavourite(ls.id, false); setFavourite(saved.id, true); }
      delete local[ls.id];
      moved++;
      await Store.set(SPLITS_KEY, local);
    } catch(err){
      if(isNetworkError(err)) throw err;
      toast(`Couldn’t save "${ls.name}" to your account: ${err.message}`);
      break;
    }
  }
  if(!Object.keys(local).length) await Store.del(SPLITS_KEY);
  if(moved) toast(`${moved} split${moved > 1 ? 's' : ''} from this device saved to your account`);
}

// Send queued changes, move guest splits up, then pull the latest of everything.
async function syncWithServer(firstLoad){
  if(!CLOUD || !user || syncing) return;
  syncing = true;
  renderStatusBar();
  try{
    await flushOutbox();
    if(firstLoad){
      try{
        const joined = await Cloud.acceptInvites();
        if(joined) toast(`You were added to ${joined} shared split${joined > 1 ? 's' : ''}`);
      } catch(err){ if(isNetworkError(err)) throw err; }
    }
    await uploadGuestSplits();
    splits = await Cloud.loadAll();
    persistSplits();
  } catch(err){
    if(!isNetworkError(err)) toast('Could not load your splits: ' + err.message);
    else if(!IS_PWA) toast('You’re offline — connect to the internet to load your splits');
  } finally {
    syncing = false;
    cloudLoading = false;
    renderStatusBar();
  }
}

/* --- header notice --- */
function renderStatusBar(){
  const bar = $('statusBar');
  let html = '', cls = 'statusbar';
  if(CLOUD && !user && authReady){
    html = `<span class="sb-long">💾 Saved on this device only — <strong>log in to save your data and sync</strong> it everywhere.</span>
      <span class="sb-short">💾 Saved on this device — <strong>log in to sync</strong></span>`;
  } else if(CLOUD && user && IS_PWA && (!navigator.onLine || outbox.length)){
    const n = outbox.length;
    const changes = `${n} change${n > 1 ? 's' : ''}`;
    cls += ' statusbar-offline';
    html = navigator.onLine
      ? `<span>🔄 Syncing ${changes}…</span>`
      : `<span>📴 Offline — showing your saved splits.${n ? ` ${changes} will sync when you’re back online.` : ''}</span>`;
  }
  bar.className = cls;
  bar.hidden = !html;
  bar.innerHTML = html;
}

/* ---------------- CLOUD: REALTIME ---------------- */
let liveStatus = '';

// Re-draw whatever is on screen after data changed underneath it.
function rerender(splitId){
  if(!localMode()) persistSplits();   // keep the offline copy current
  if(currentView === 'split'){
    if(!getSplit(currentSplitId)){
      if(idRemap[currentSplitId]){ location.replace(`#/split/${encodeURIComponent(idRemap[currentSplitId])}`); return; }
      toast('This split was deleted or you no longer have access'); location.hash = '#/splits'; return;
    }
    if(!splitId || splitId === currentSplitId) renderSplitDetail(currentSplitId, true);
  } else if(currentView === 'splits'){
    renderSplitList(true);
  } else if(currentView === 'home'){
    renderHome();
  }
}

function findEntrySplit(entryId){
  return Object.values(splits).find(s => s.entries.some(e => e.id === entryId));
}

const liveHandlers = {
  entryChanged(en){
    const s = getSplit(en.splitId);
    if(!s) return;
    const i = s.entries.findIndex(x => x.id === en.id);
    if(i >= 0) s.entries[i] = en; else s.entries.push(en);
    rerender(s.id);
  },
  entryDeleted(id){
    const s = findEntrySplit(id);
    if(!s) return;
    s.entries = s.entries.filter(x => x.id !== id);
    if(editingEntryId === id && !$('entrySheet').hidden){ closeSheet('entrySheet'); toast('Someone deleted this entry'); }
    rerender(s.id);
  },
  splitChanged(id, apply){
    const s = getSplit(id);
    if(s){ apply(s); rerender(id); }
    else refreshSplit(id);
  },
  splitDeleted(id){
    if(!getSplit(id)) return;
    delete splits[id];
    rerender(id);
  },
  accessChanged(type, row){
    if(!row || !row.split_id) return;
    if(type === 'DELETE' && row.user_id === user.id){ delete splits[row.split_id]; rerender(row.split_id); return; }
    refreshSplit(row.split_id);   // someone joined/left, or we were added
  },
  status(st){
    liveStatus = st;
    if(currentView === 'split' && $('liveDot')) $('liveDot').hidden = st !== 'SUBSCRIBED';
  }
};

/* ---------------- INIT ---------------- */
let signedInAs = null;
let resumedOffline = false;

async function onSignedIn(session){
  if(signedInAs === session.user.id){
    // Back online after an offline start: the session is valid again.
    if(resumedOffline){ resumedOffline = false; Cloud.subscribe(liveHandlers); await syncWithServer(false); rerender(); }
    return;
  }
  signedInAs = session.user.id;
  authReady = true;
  cloudLoading = true;
  user = await Cloud.profileFor(session);
  splits = {};   // device-only splits are uploaded by syncWithServer, not shown as account data
  renderAuth();
  if(IS_PWA){
    // Installed app: show the offline copy straight away, then refresh it.
    Store.set('last_user', user).catch(() => {});
    outbox = await Store.get(outboxKey(), []);
    const cached = await Store.get(cacheKey(), null);
    if(cached){ splits = cached; cloudLoading = false; route(); }
  }
  renderStatusBar();
  await syncWithServer(true);
  Cloud.subscribe(liveHandlers);
  const back = takeReturn();
  if(!$('loginSheet').hidden) finishLogin();
  else if(back && back !== location.hash && (!location.hash || location.hash === '#/')) location.hash = back;
  else route();
}

// Installed app opened offline after the login token expired: Supabase can't
// refresh it, so it reports no session. Carry on with the offline copy; the
// session refreshes by itself once we're back online and catchUp() syncs.
async function resumeOffline(){
  if(!IS_PWA || navigator.onLine) return false;
  const last = await Store.get('last_user', null);
  const hasSession = Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k));
  if(!last || !hasSession) return false;
  signedInAs = last.id;
  resumedOffline = true;
  authReady = true;
  user = last;
  Cloud.userId = last.id;
  outbox = await Store.get(outboxKey(), []);
  splits = await Store.get(cacheKey(), {});
  cloudLoading = false;
  renderAuth();
  renderStatusBar();
  route();
  return true;
}

async function onSignedOut(){
  signedInAs = null;
  authReady = true;
  user = null;
  outbox = [];
  splits = await Store.get(SPLITS_KEY, {});
  cloudLoading = false;
  renderAuth();
  renderStatusBar();
  route();
}

async function init(){
  if(window.Cloud && Cloud.configured && !Cloud.enabled){
    toast('Could not reach the sync service — running offline');
  }
  renderAuth();
  route();   // "Loading…" until we know who you are
  await Store.adopt(SPLITS_KEY);
  if(!CLOUD){
    splits = await Store.get(SPLITS_KEY, {});
    cloudLoading = false;
    route();
    return;
  }
  Cloud.onAuthChange(async (event, session) => {
    if(session) onSignedIn(session);
    else if(event === 'INITIAL_SESSION' && await resumeOffline()) return;
    else if(event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') onSignedOut();
  });
  // Catch up when coming back to the app or getting a connection back.
  const catchUp = async () => {
    if(!user || cloudLoading) return;
    await syncWithServer(false);
    rerender();
  };
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') catchUp(); });
  window.addEventListener('online', () => { renderStatusBar(); catchUp(); });
  window.addEventListener('offline', renderStatusBar);
}
init();
