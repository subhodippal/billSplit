let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    document.getElementById("installBtn").style.display = "block";
});

document.getElementById("installBtn").addEventListener("click", async () => {
    deferredPrompt.prompt();

    const choice = await deferredPrompt.userChoice;

    if (choice.outcome === "accepted") {
        console.log("Installed");
    }

    deferredPrompt = null;
});


let friends = [];        // array of strings
let expenses = [];       // {id, purpose, amount, paidBy, split:[names]}
let editingId = null;

/* ---------------- FRIENDS ---------------- */
function addFriend(){
  const input = document.getElementById('friendInput');
  const name = input.value.trim();
  if(!name) return;
  if(friends.some(f => f.toLowerCase() === name.toLowerCase())){
    input.value = '';
    return;
  }
  friends.push(name);
  input.value = '';
  renderFriends();
  renderPaidBySelect();
  renderSplitBox();
}

function removeFriend(name){
  const usedIn = expenses.filter(e => e.paidBy === name || e.split.includes(name));
  if(usedIn.length > 0){
    if(!confirm(`${name} appears in ${usedIn.length} expense(s). Remove anyway? Those expenses will be updated.`)) return;
  }
  friends = friends.filter(f => f !== name);
  expenses.forEach(e => { e.split = e.split.filter(n => n !== name); });
  expenses = expenses.filter(e => e.paidBy !== name);
  renderFriends();
  renderPaidBySelect();
  renderSplitBox();
  renderExpenseTable();
}

function renderFriends(){
  const box = document.getElementById('friendChips');
  box.innerHTML = '';
  friends.forEach(name => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `<span class="avatar-dot"></span><span>${escapeHtml(name)}</span>
      <button onclick="removeFriend('${escapeAttr(name)}')" title="Remove">×</button>`;
    box.appendChild(chip);
  });
}

/* ---------------- EXPENSE FORM ---------------- */
function renderPaidBySelect(){
  const sel = document.getElementById('expPaidBy');
  const prev = sel.value;
  sel.innerHTML = friends.map(f => `<option value="${escapeAttr(f)}">${escapeHtml(f)}</option>`).join('');
  if(friends.includes(prev)) sel.value = prev;
}

function renderSplitBox(preselected){
  const box = document.getElementById('splitBox');
  const selected = preselected || friends.slice();
  box.innerHTML = '';
  friends.forEach(f => {
    const isActive = selected.includes(f);
    const pill = document.createElement('label');
    pill.className = 'split-pill' + (isActive ? ' active' : '');
    pill.innerHTML = `<input type="checkbox" data-name="${escapeAttr(f)}" ${isActive?'checked':''}> ${escapeHtml(f)}`;
    pill.querySelector('input').addEventListener('change', function(){
      pill.classList.toggle('active', this.checked);
    });
    box.appendChild(pill);
  });
}

function getSelectedSplit(){
  return Array.from(document.querySelectorAll('#splitBox input[type=checkbox]:checked')).map(el => el.dataset.name);
}

function submitExpenseForm(){
  const purpose = document.getElementById('expPurpose').value.trim();
  const amount = parseFloat(document.getElementById('expAmount').value);
  const paidBy = document.getElementById('expPaidBy').value;
  const split = getSelectedSplit();

  if(friends.length === 0){ alert('Add at least one friend first (Step 1).'); return; }
  if(!purpose){ alert('Enter a purpose for this expense.'); return; }
  if(isNaN(amount) || amount < 0){ alert('Enter a valid amount (0 or more).'); return; }
  if(!paidBy){ alert('Select who paid.'); return; }
  if(split.length === 0){ alert('Select at least one person to split this expense among.'); return; }

  if(editingId){
    const exp = expenses.find(e => e.id === editingId);
    exp.purpose = purpose; exp.amount = amount; exp.paidBy = paidBy; exp.split = split;
    cancelEdit();
  } else {
    expenses.push({ id: cryptoId(), purpose, amount, paidBy, split });
  }

  document.getElementById('expPurpose').value = '';
  document.getElementById('expAmount').value = '';
  renderSplitBox();
  renderExpenseTable();
}

function cancelEdit(){
  editingId = null;
  document.getElementById('expSubmitBtn').textContent = 'Add expense';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.getElementById('expPurpose').value = '';
  document.getElementById('expAmount').value = '';
  renderSplitBox();
}

function editExpense(id){
  const exp = expenses.find(e => e.id === id);
  if(!exp) return;
  editingId = id;
  document.getElementById('expPurpose').value = exp.purpose;
  document.getElementById('expAmount').value = exp.amount;
  renderPaidBySelect();
  document.getElementById('expPaidBy').value = exp.paidBy;
  renderSplitBox(exp.split);
  document.getElementById('expSubmitBtn').textContent = 'Save changes';
  document.getElementById('cancelEditBtn').style.display = 'inline-block';
  document.querySelector('#expPurpose').scrollIntoView({behavior:'smooth', block:'center'});
}

function deleteExpense(id){
  if(!confirm('Delete this expense?')) return;
  expenses = expenses.filter(e => e.id !== id);
  if(editingId === id) cancelEdit();
  renderExpenseTable();
}

function renderExpenseTable(){
  const body = document.getElementById('expenseTableBody');
  const emptyNote = document.getElementById('emptyExpenseNote');
  body.innerHTML = '';
  if(expenses.length === 0){
    emptyNote.style.display = 'block';
    document.getElementById('expenseTable').style.display = 'none';
    return;
  }
  emptyNote.style.display = 'none';
  document.getElementById('expenseTable').style.display = 'table';

  expenses.forEach(e => {
    const excluded = friends.filter(f => !e.split.includes(f));
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(e.purpose)}</td>
      <td class="amt-mono">₹${formatNum(e.amount)}</td>
      <td>${escapeHtml(e.paidBy)}</td>
      <td>${e.split.length} of ${friends.length}
        ${excluded.length ? `<span class="excl-note">excl. ${excluded.map(escapeHtml).join(', ')}</span>` : ''}
      </td>
      <td style="white-space:nowrap;">
        <button class="btn-icon" title="Edit" onclick="editExpense('${e.id}')">✏️</button>
        <button class="btn-icon" title="Delete" onclick="deleteExpense('${e.id}')">🗑️</button>
      </td>`;
    body.appendChild(tr);
  });
}

/* ---------------- PASTE PARSER ---------------- */
function parsePaste(){
  const raw = document.getElementById('pasteArea').value;
  if(!raw.trim()) return;
  if(friends.length === 0){ alert('Add friends first (Step 1) so pasted rows can be split among them.'); return; }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = [];

  lines.forEach(line => {
    const parts = line.split(',').map(p => p.trim());
    if(parts.length < 3){ skipped.push(line); return; }
    const purpose = parts[0];
    const amount = parseFloat(parts[1]);
    const paidBy = parts[2];
    if(!purpose || isNaN(amount) || !paidBy){ skipped.push(line); return; }

    // match paidBy case-insensitively to an existing friend, or add as new friend
    let matched = friends.find(f => f.toLowerCase() === paidBy.toLowerCase());
    if(!matched){
      friends.push(paidBy);
      matched = paidBy;
    }
    expenses.push({ id: cryptoId(), purpose, amount, paidBy: matched, split: friends.slice() });
    added++;
  });

  renderFriends();
  renderPaidBySelect();
  renderSplitBox();
  renderExpenseTable();
  document.getElementById('pasteArea').value = '';

  let msg = `Added ${added} expense(s).`;
  if(skipped.length) msg += ` Skipped ${skipped.length} line(s) that didn't match "purpose, amount, paid by".`;
  alert(msg);
}

/* ---------------- CALCULATE ---------------- */
function calculate(){
  if(expenses.length === 0){ alert('Add at least one expense first.'); return; }

  const total = expenses.reduce((s,e) => s + e.amount, 0);

  const paid = {};   // how much each person paid
  const share = {};  // how much each person owes (their portion of expenses they're included in)
  friends.forEach(f => { paid[f] = 0; share[f] = 0; });

  expenses.forEach(e => {
    paid[e.paidBy] = (paid[e.paidBy] || 0) + e.amount;
    const n = e.split.length;
    if(n === 0) return;
    const per = e.amount / n;
    e.split.forEach(name => { share[name] = (share[name] || 0) + per; });
  });

  const balance = {};
  friends.forEach(f => { balance[f] = round2((paid[f]||0) - (share[f]||0)); });

  // settle up — greedy min transactions
  let creditors = friends.filter(f => balance[f] > 0.005).map(f => ({name:f, amt: balance[f]})).sort((a,b)=>b.amt-a.amt);
  let debtors = friends.filter(f => balance[f] < -0.005).map(f => ({name:f, amt: -balance[f]})).sort((a,b)=>b.amt-a.amt);
  const transactions = [];
  let ci = 0, di = 0;
  creditors = creditors.map(c=>({...c}));
  debtors = debtors.map(d=>({...d}));
  while(ci < creditors.length && di < debtors.length){
    const c = creditors[ci], d = debtors[di];
    const amt = Math.min(c.amt, d.amt);
    if(amt > 0.005) transactions.push({from: d.name, to: c.name, amount: round2(amt)});
    c.amt = round2(c.amt - amt);
    d.amt = round2(d.amt - amt);
    if(c.amt <= 0.005) ci++;
    if(d.amt <= 0.005) di++;
  }

  renderResults(total, paid, share, balance, transactions);
}

function renderResults(total, paid, share, balance, transactions){
  document.getElementById('resultsArea').style.display = 'block';

  const perHead = friends.length ? total / friends.length : 0;
  document.getElementById('statGrid').innerHTML = `
    <div class="stat-box"><div class="stat-label">Total spent</div><div class="stat-value">₹${formatNum(total)}</div></div>
    <div class="stat-box"><div class="stat-label">Travellers</div><div class="stat-value">${friends.length}</div></div>
    <div class="stat-box"><div class="stat-label">Expenses logged</div><div class="stat-value">${expenses.length}</div></div>
    <div class="stat-box"><div class="stat-label">Avg / person</div><div class="stat-value">₹${formatNum(perHead)}</div></div>
  `;

  document.getElementById('spentList').innerHTML = friends.map(f => `
    <div class="person-row">
      <span class="person-name"><span class="avatar-dot" style="width:7px;height:7px;border-radius:50%;background:var(--sage);display:inline-block;"></span>${escapeHtml(f)}</span>
      <span class="amt-mono">₹${formatNum(paid[f]||0)}</span>
    </div>`).join('');

  document.getElementById('shareList').innerHTML = friends.map(f => {
    const b = balance[f];
    const cls = b > 0.005 ? 'bal-pos' : (b < -0.005 ? 'bal-neg' : 'bal-zero');
    const label = b > 0.005 ? `gets back ₹${formatNum(b)}` : (b < -0.005 ? `owes ₹${formatNum(-b)}` : 'settled up');
    return `<div class="person-row">
      <span class="person-name">${escapeHtml(f)} <span style="font-weight:400;color:var(--ink-soft);font-size:12.5px;">— share ₹${formatNum(share[f]||0)}</span></span>
      <span class="${cls}">${label}</span>
    </div>`;
  }).join('');

  const settleBox = document.getElementById('settleList');
  if(transactions.length === 0){
    settleBox.innerHTML = `<div class="settle-empty">Everyone's already even. No payments needed 🎉</div>`;
  } else {
    settleBox.innerHTML = transactions.map(t => `
      <div class="settle-row">
        <span><strong>${escapeHtml(t.from)}</strong></span>
        <span class="arrow">→</span>
        <span><strong>${escapeHtml(t.to)}</strong></span>
        <span class="amt">₹${formatNum(t.amount)}</span>
      </div>`).join('');
  }

  document.getElementById('resultsArea').scrollIntoView({behavior:'smooth', block:'nearest'});
}

/* ---------------- SNAPSHOT DOWNLOAD ---------------- */
function downloadSnapshot(){
  const el = document.getElementById('downloadArea');
  const btn = event.target;
  const origText = btn.textContent;
  btn.textContent = 'Preparing…';
  btn.disabled = true;
  html2canvas(el, {backgroundColor: '#F4EFE1', scale: 2}).then(canvas => {
    const link = document.createElement('a');
    link.download = 'trip-ledger-summary.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    btn.textContent = origText;
    btn.disabled = false;
  }).catch(err => {
    alert('Could not generate snapshot: ' + err.message);
    btn.textContent = origText;
    btn.disabled = false;
  });
}

/* ---------------- UTILS ---------------- */
function cryptoId(){ return 'e' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function round2(n){ return Math.round(n*100)/100; }
function formatNum(n){ return (Math.round(n*100)/100).toLocaleString('en-IN', {minimumFractionDigits:0, maximumFractionDigits:2}); }
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(str){ return String(str).replace(/'/g, "\\'"); }

/* init */
renderFriends();
renderPaidBySelect();
renderSplitBox();
renderExpenseTable();