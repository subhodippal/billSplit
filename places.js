/* =========================================================
   SplitEasy — location suggestions while typing
   Google Places when config.js has a googleMapsKey, otherwise the free
   OpenStreetMap search (Photon). Picking a suggestion also pins its map
   location; anything typed without picking is kept as a custom name.
   ========================================================= */
(function(){
  const KEY = (window.SPLITEASY_CONFIG || {}).googleMapsKey || '';
  const GOOGLE = !!KEY;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const r6 = n => Math.round(n * 1e6) / 1e6;
  const newToken = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  // ---- Google Places (New) ----
  async function googleSuggest(q, token, bias){
    const body = { input: q, sessionToken: token };
    if(bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000 } };
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
      body: JSON.stringify(body)
    });
    if(!res.ok) throw new Error('Places ' + res.status);
    const j = await res.json();
    return (j.suggestions || []).filter(s => s.placePrediction).map(s => {
      const p = s.placePrediction, f = p.structuredFormat || {};
      return { id: p.placeId, main: (f.mainText && f.mainText.text) || p.text.text, sub: (f.secondaryText && f.secondaryText.text) || '' };
    });
  }
  async function googleGeo(item, token){
    try{
      const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(item.id)}?sessionToken=${encodeURIComponent(token)}`,
        { headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'location' } });
      if(!res.ok) return null;
      const j = await res.json();
      return j.location ? { lat: r6(j.location.latitude), lng: r6(j.location.longitude) } : null;
    } catch(_){ return null; }
  }

  // ---- OpenStreetMap (Photon) ----
  async function osmSuggest(q, _token, bias){
    let url = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}`;
    if(bias) url += `&lat=${bias.lat}&lon=${bias.lng}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('Photon ' + res.status);
    const j = await res.json();
    const seen = new Set();
    return (j.features || []).map(f => {
      const p = f.properties || {};
      const main = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || '';
      const parts = [p.city || p.county || p.district, p.state, p.country].filter(x => x && x !== main);
      return { main, sub: [...new Set(parts)].join(', '), geo: { lat: r6(f.geometry.coordinates[1]), lng: r6(f.geometry.coordinates[0]) } };
    }).filter(x => {
      const k = (x.main + '|' + x.sub).toLowerCase();
      if(!x.main || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const suggest = GOOGLE ? googleSuggest : osmSuggest;

  // opts: onPick(geo) when a suggestion is chosen, onType() when a picked place
  // is edited by hand (its pin no longer applies), bias() -> {lat,lng} to search near.
  window.attachPlaceSuggest = function(input, opts){
    const wrap = input.parentElement;
    wrap.classList.add('place-wrap');
    const list = document.createElement('div');
    list.className = 'place-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('autocomplete', 'off');

    let items = [], active = -1, timer = null, seq = 0, token = newToken(), picked = false;

    function close(){ list.hidden = true; active = -1; seq++; }

    function render(){
      const q = input.value.trim();
      if(!q){ close(); return; }
      // First row keeps exactly what was typed (custom name, no pin).
      list.innerHTML =
        `<button type="button" class="place-item place-custom" data-i="-1">✎ Use “${esc(q)}”</button>` +
        items.map((it, i) => `<button type="button" class="place-item" data-i="${i}">
            <span class="place-pin">📍</span><span><strong>${esc(it.main)}</strong>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
          </button>`).join('') +
        `<div class="place-credit">${GOOGLE ? 'Powered by Google' : '© OpenStreetMap contributors'}</div>`;
      highlight();
      list.hidden = false;
    }

    function highlight(){
      list.querySelectorAll('.place-item').forEach(b => b.classList.toggle('active', Number(b.dataset.i) === active));
    }

    async function choose(i){
      close();
      if(i < 0) return;   // keep the typed text as a custom name
      const it = items[i];
      // "Darjeeling" + "Darjeeling Pulbazar, West Bengal, India" -> "Darjeeling, West Bengal"
      const main = it.main.toLowerCase();
      const area = it.sub.split(',').map(s => s.trim())
        .find(s => s && !s.toLowerCase().includes(main) && !main.includes(s.toLowerCase()));
      input.value = area ? `${it.main}, ${area}` : it.main;
      picked = true;
      const geo = it.geo || (GOOGLE ? await googleGeo(it, token) : null);
      token = newToken();   // a Google session ends with a pick
      opts.onPick(geo);
    }

    input.addEventListener('input', () => {
      if(picked){ picked = false; if(opts.onType) opts.onType(); }
      clearTimeout(timer);
      const q = input.value.trim();
      if(q.length < 2){ close(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try{
          const res = await suggest(q, token, opts.bias ? opts.bias() : null);
          if(mine !== seq) return;
          items = res;
          active = -1;
          render();
        } catch(_){ if(mine === seq){ items = []; render(); } }
      }, 250);
    });

    input.addEventListener('keydown', e => {
      if(list.hidden) return;
      const max = items.length - 1;
      if(e.key === 'ArrowDown'){ e.preventDefault(); active = Math.min(active + 1, max); highlight(); }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); active = Math.max(active - 1, -1); highlight(); }
      else if(e.key === 'Enter'){ e.preventDefault(); choose(active); }
      else if(e.key === 'Escape'){ e.stopPropagation(); close(); }
    });

    list.addEventListener('mousedown', e => e.preventDefault());   // keep focus in the input
    list.addEventListener('click', e => {
      const b = e.target.closest('.place-item');
      if(b) choose(Number(b.dataset.i));
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  };
})();
