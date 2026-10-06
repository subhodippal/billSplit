/* =========================================================
   SplitEasy — device storage
   Installed app (PWA): IndexedDB — room for lots of data and a full offline copy.
   Browser tab: localStorage — only holds splits made before logging in.
   ========================================================= */
(function(){
  const IS_PWA = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
                 navigator.standalone === true;   // iOS home-screen app

  const Local = {
    async get(key, fallback){
      try{ const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
      catch(_){ return fallback; }
    },
    async set(key, value){ localStorage.setItem(key, JSON.stringify(value)); },
    async del(key){ try{ localStorage.removeItem(key); } catch(_){} }
  };

  let dbPromise = null;
  function db(){
    if(!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('spliteasy', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function run(mode, fn){
    return db().then(d => new Promise((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    }));
  }
  const Idb = {
    async get(key, fallback){
      try{ const v = await run('readonly', s => s.get(key)); return v ?? fallback; }
      catch(_){ return fallback; }
    },
    set: (key, value) => run('readwrite', s => s.put(value, key)),
    del: key => run('readwrite', s => s.delete(key)).catch(() => {})
  };

  const useIdb = IS_PWA && 'indexedDB' in window;
  window.Store = Object.assign({ isPWA: IS_PWA, kind: useIdb ? 'indexeddb' : 'localstorage' }, useIdb ? Idb : Local);

  // First launch as an installed app: bring over anything the browser version saved.
  Store.adopt = async function(key){
    if(!useIdb) return;
    const fromLocal = await Local.get(key, null);
    if(!fromLocal) return;
    const current = await Idb.get(key, {});
    await Idb.set(key, Object.assign({}, fromLocal, current));
    await Local.del(key);
  };
})();
