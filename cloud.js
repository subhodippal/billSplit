/* =========================================================
   SplitEasy — Supabase data layer (accounts, storage, realtime)
   Active only when config.js has a Supabase URL and anon key.
   ========================================================= */
(function(){
  const cfg = window.SPLITEASY_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const libLoaded = !!(window.supabase && window.supabase.createClient);

  const Cloud = {
    configured,
    enabled: configured && libLoaded,
    sb: null,
    userId: null
  };
  window.Cloud = Cloud;
  if(!Cloud.enabled) return;

  const sb = Cloud.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
  });

  function check({ data, error }){
    if(error) throw new Error(error.message || 'Request failed');
    return data;
  }

  /* ---------- row mapping ---------- */
  function geoOf(r){ return r.geo_lat != null && r.geo_lng != null ? { lat: r.geo_lat, lng: r.geo_lng } : null; }
  function ts(v){ return v ? Date.parse(v.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z') : Date.now(); }

  function rowToEntry(r){
    return {
      id: r.id,
      splitId: r.split_id,
      datetime: String(r.occurred_at || '').slice(0, 16),
      amount: Number(r.amount),
      sign: Number(r.sign) < 0 ? -1 : 1,
      purpose: r.purpose,
      payVia: r.pay_via || '',
      paidBy: r.paid_by,
      location: r.location || '',
      geo: geoOf(r),
      note: r.note || '',
      splitAmong: r.split_among || [],
      addedBy: r.added_by,
      createdAt: ts(r.created_at),
      updatedAt: ts(r.updated_at),
      updatedBy: r.updated_by
    };
  }

  function entryToRow(splitId, en){
    return {
      id: en.id,
      split_id: splitId,
      occurred_at: en.datetime,
      amount: en.amount,
      sign: en.sign,
      purpose: en.purpose,
      pay_via: en.payVia || '',
      paid_by: en.paidBy,
      location: en.location || '',
      geo_lat: en.geo ? en.geo.lat : null,
      geo_lng: en.geo ? en.geo.lng : null,
      note: en.note || '',
      split_among: en.splitAmong,
      added_by: en.addedBy,
      updated_by: en.updatedBy
    };
  }

  // Columns of a split row that the app edits directly (people go through RPCs).
  function splitMetaToRow(s){
    return {
      name: s.name,
      type: s.type,
      currency: s.currency,
      location: s.location || '',
      geo_lat: s.geo ? s.geo.lat : null,
      geo_lng: s.geo ? s.geo.lng : null,
      pay_modes: s.payModes,
      updated_by: s.updatedBy
    };
  }

  function applySplitRow(target, r){
    Object.assign(target, {
      id: r.id,
      name: r.name,
      type: r.type,
      currency: r.currency,
      location: r.location || '',
      geo: geoOf(r),
      members: r.members || [],
      payModes: r.pay_modes || [],
      shareCode: r.share_code,
      createdBy: r.created_by_name,
      createdById: r.created_by,
      createdAt: ts(r.created_at),
      updatedAt: ts(r.updated_at),
      updatedBy: r.updated_by
    });
    return target;
  }

  function rowToSplit(r){
    const s = applySplitRow({ cloud: true, entries: [] }, r);
    s.entries = (r.entries || []).map(rowToEntry);
    const access = r.split_members || [];
    const mine = access.find(m => m.user_id === Cloud.userId);
    s.role = mine ? mine.role : (r.created_by === Cloud.userId ? 'owner' : 'editor');
    s.collaborators = access.length;
    return s;
  }

  const SPLIT_SELECT = '*, entries(*), split_members(user_id, role)';

  /* ---------- auth ---------- */
  Cloud.onAuthChange = function(cb){
    sb.auth.onAuthStateChange((event, session) => { setTimeout(() => cb(event, session), 0); });
  };
  Cloud.getSession = async function(){
    const { data } = await sb.auth.getSession();
    return data.session;
  };
  Cloud.profileFor = async function(session){
    Cloud.userId = session.user.id;
    const { data } = await sb.from('profiles').select('display_name, email').eq('id', session.user.id).maybeSingle();
    const meta = session.user.user_metadata || {};
    return {
      id: session.user.id,
      email: session.user.email,
      name: (data && data.display_name) || meta.display_name || (session.user.email || '').split('@')[0]
    };
  };
  Cloud.signIn = async (email, password) => check(await sb.auth.signInWithPassword({ email, password }));
  Cloud.signUp = async (name, email, password) => check(await sb.auth.signUp({
    email, password,
    options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname }
  }));
  Cloud.magicLink = async (email, name) => check(await sb.auth.signInWithOtp({
    email,
    options: { data: name ? { display_name: name } : undefined, emailRedirectTo: location.origin + location.pathname }
  }));
  Cloud.signOut = async () => {
    if(channel){ await sb.removeChannel(channel); channel = null; }
    check(await sb.auth.signOut());
    Cloud.userId = null;
  };
  Cloud.updateName = async (name) => {
    check(await sb.from('profiles').update({ display_name: name }).eq('id', Cloud.userId));
    await sb.auth.updateUser({ data: { display_name: name } });
  };

  /* ---------- splits ---------- */
  Cloud.loadAll = async function(){
    const rows = check(await sb.from('splits').select(SPLIT_SELECT).order('updated_at', { ascending: false }));
    const out = {};
    rows.forEach(r => { out[r.id] = rowToSplit(r); });
    return out;
  };
  Cloud.loadSplit = async function(id){
    const r = check(await sb.from('splits').select(SPLIT_SELECT).eq('id', id).maybeSingle());
    return r ? rowToSplit(r) : null;
  };
  Cloud.createSplit = async function(s){
    check(await sb.from('splits').insert({
      id: s.id, ...splitMetaToRow(s), members: s.members, created_by: Cloud.userId, created_by_name: s.createdBy
    }));
    return Cloud.loadSplit(s.id);
  };
  Cloud.saveSplitMeta = async s => check(await sb.from('splits').update(splitMetaToRow(s)).eq('id', s.id));
  Cloud.deleteSplit = async s => check(await sb.from('splits').delete().eq('id', s.id));
  Cloud.leaveSplit = async s => check(await sb.from('split_members').delete().eq('split_id', s.id).eq('user_id', Cloud.userId));

  /* ---------- people (names in a split) ---------- */
  Cloud.addPerson = async (s, name) => check(await sb.rpc('add_person', { p_split: s.id, p_name: name }));
  Cloud.renamePerson = async (s, oldName, newName) => check(await sb.rpc('rename_person', { p_split: s.id, p_old: oldName, p_new: newName }));
  Cloud.removePerson = async (s, name) => check(await sb.rpc('remove_person', { p_split: s.id, p_name: name }));

  /* ---------- entries ---------- */
  Cloud.saveEntry = async (s, en) => check(await sb.from('entries').upsert(entryToRow(s.id, en)));
  Cloud.deleteEntry = async en => check(await sb.from('entries').delete().eq('id', en.id));

  /* ---------- sharing ---------- */
  Cloud.collaborators = async function(s){
    const members = check(await sb.from('split_members')
      .select('user_id, role, joined_at, profiles(display_name, email)')
      .eq('split_id', s.id).order('joined_at'));
    const invites = check(await sb.from('split_invites').select('email, created_at').eq('split_id', s.id).order('created_at'));
    return {
      members: members.map(m => ({
        userId: m.user_id, role: m.role,
        name: m.profiles ? m.profiles.display_name : '', email: m.profiles ? m.profiles.email : ''
      })),
      invites: invites.map(i => i.email)
    };
  };
  Cloud.invite = async (s, email) => check(await sb.rpc('invite_to_split', { p_split: s.id, p_email: email }));
  Cloud.cancelInvite = async (s, email) => check(await sb.from('split_invites').delete().eq('split_id', s.id).eq('email', email));
  Cloud.removeCollaborator = async (s, userId) => check(await sb.from('split_members').delete().eq('split_id', s.id).eq('user_id', userId));
  Cloud.joinByCode = async code => check(await sb.rpc('join_split', { p_code: code }));
  Cloud.acceptInvites = async () => check(await sb.rpc('accept_invites'));
  Cloud.resetShareCode = async s => check(await sb.rpc('reset_share_code', { p_split: s.id }));

  // Copy a split saved on this device (or from an old share link) into the account.
  Cloud.uploadSplit = async function(local){
    const id = crypto.randomUUID();
    check(await sb.from('splits').insert({
      id,
      ...splitMetaToRow(local),
      members: local.members,
      created_by: Cloud.userId,
      created_by_name: local.createdBy
    }));
    const rows = (local.entries || []).filter(e => !e.deleted).map(e => {
      const row = entryToRow(id, e);
      row.id = crypto.randomUUID();
      return row;
    });
    if(rows.length) check(await sb.from('entries').insert(rows));
    return Cloud.loadSplit(id);
  };

  /* ---------- realtime ---------- */
  // One channel for everything; row-level security decides which rows each user receives.
  let channel = null;
  Cloud.subscribe = async function(h){
    if(channel){ const old = channel; channel = null; await sb.removeChannel(old); }
    channel = sb.channel('spliteasy-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, p => {
        if(p.eventType === 'DELETE') h.entryDeleted(p.old.id);
        else h.entryChanged(rowToEntry(p.new));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'splits' }, p => {
        if(p.eventType === 'DELETE') h.splitDeleted(p.old.id);
        else h.splitChanged(p.new.id, row => applySplitRow(row, p.new));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'split_members' }, p => {
        h.accessChanged(p.eventType, p.new && p.new.split_id ? p.new : p.old);
      })
      .subscribe(status => h.status && h.status(status));
    return channel;
  };
})();
