const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const money = n => Number.isFinite(n) ? fmt.format(n) : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const sign = (element, n) => { element.classList.toggle('positive', n > 0); element.classList.toggle('negative', n < 0); };
let current = {}, points = [], lastReceived = 0, editing = false, initializedSettings = false, toastTimer;
const set = (id, text) => { $(id).textContent = text; };
function toast(text) { set('toast', text); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
async function control(body) {
  const response = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Control request failed'); return result;
}
function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function book(id, b) {
  const body = $(id); body.replaceChildren();
  for (let i = 0; i < 5; i++) {
    const bid = b?.bids?.[i], ask = b?.asks?.[i], tr = document.createElement('tr');
    tr.append(cell(bid ? Math.round(bid.size).toLocaleString() : '—'), cell(bid ? (bid.price * 100).toFixed(1) : '—'), cell(ask ? (ask.price * 100).toFixed(1) : '—'), cell(ask ? Math.round(ask.size).toLocaleString() : '—')); body.append(tr);
  }
}
function positions(rows) {
  const list = $('position-list'); set('position-count', rows.length);
  if (!rows.length) {
    list.replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty';
    const icon = document.createElement('span'); icon.textContent = '↗'; const text = document.createTextNode('No open positions');
    const help = document.createElement('small'); help.textContent = 'The bot enters only when price, liquidity, and risk conditions agree.'; empty.append(icon, text, help); list.append(empty); return;
  }
  list.replaceChildren();
  for (const p of rows) {
    const item = document.createElement('article'); item.className = 'position';
    const top = document.createElement('div'); top.className = 'position-top';
    const title = document.createElement('div'); title.className = `position-title ${p.side === 0 ? 'up' : 'down'}`; title.textContent = `${p.side === 0 ? '↗ UP' : '↘ DOWN'} · ${p.shares.toFixed(2)} shares`;
    const subtitle = document.createElement('small'); subtitle.textContent = `${money(p.cost)} committed · ${p.exitIntent || p.status}`; title.append(subtitle);
    const pnl = document.createElement('div'); pnl.className = 'position-pnl'; pnl.textContent = money(p.markPnl); sign(pnl, p.markPnl);
    const roi = document.createElement('small'); roi.textContent = `${pct(p.roi)} quoted net return`; pnl.append(roi); top.append(title, pnl);
    const bottom = document.createElement('div'); bottom.className = 'position-bottom';
    for (const text of [`Held ${p.heldSeconds}s`, `TP +${(current.settings.takeProfit * 100).toFixed(0)}% / SL −${(current.settings.stopLoss * 100).toFixed(0)}%`]) { const s = document.createElement('span'); s.textContent = text; bottom.append(s); }
    const close = document.createElement('button'); close.className = 'button secondary'; close.textContent = 'Close position'; close.disabled = p.status !== 'OPEN';
    close.addEventListener('click', async () => { close.disabled = true; try { await control({ action: 'close', slug: p.slug, side: p.side }); toast('Paper exit queued for the next fresh order book'); } catch (e) { toast(e.message); close.disabled = false; } });
    bottom.append(close); item.append(top, bottom); list.append(item);
  }
}
function activity(events) {
  const list = $('activity'); list.replaceChildren();
  for (const e of events.slice(0, 8)) {
    const li = document.createElement('li'), top = document.createElement('div'); top.className = 'event-top';
    const type = document.createElement('span'); type.className = 'event-type'; type.textContent = e.type;
    if (e.type === 'BUY') type.classList.add('positive'); if (e.type === 'SELL') type.classList.add('negative');
    const time = document.createElement('time'); time.textContent = new Date(e.time).toLocaleTimeString(); top.append(type, time);
    const message = document.createElement('div'); message.className = 'event-message'; message.textContent = e.message; li.append(top, message); list.append(li);
  }
}
function render(data) {
  if (!data.account) return;
  current = data; lastReceived = Date.now();
  $('stale').hidden = true;
  const a = data.account, m = data.model, btc = data.btc;
  set('mode', data.demo ? 'SYNTHETIC DEMO' : 'PAPER ONLY');
  set('connection', data.status === 'CONNECTED' ? 'Books connected' : 'Feed offline'); $('connection-dot').classList.toggle('ok', data.status === 'CONNECTED');
  set('equity', money(a.nav)); set('realized', money(a.realized)); sign($('realized'), a.realized);
  set('total-pnl', `${money(a.nav - a.initial)} from ${money(a.initial)} starting cash`); sign($('total-pnl'), a.nav - a.initial);
  set('cash', money(a.cash)); set('fees', `${a.fills} fills · ${money(a.fees)} fees`);
  set('risk', money(a.risk)); set('risk-caption', `${money(a.riskCap)} maximum · 1% of ${money(a.capital)}`);
  const used = a.riskCap > 0 ? a.risk / a.riskCap : 0; $('risk-ring').style.setProperty('--progress', `${Math.min(360, used * 360)}deg`); set('risk-percent', `${Math.round(used * 100)}%`);
  set('btc-price', money(btc.price)); set('threshold', money(data.market?.settlement?.threshold));
  set('price-vs-target', Number.isFinite(btc.price) && Number.isFinite(data.market?.settlement?.threshold) ? `${money(btc.price - data.market.settlement.threshold)} vs target` : btc.status);
  set('settlement-kind', data.market?.settlement?.kind === 'TWAP' ? `${data.market.settlement.windowSeconds}s TWAP settlement` : data.market?.settlement?.kind === 'SPOT' ? 'Spot settlement' : 'Checking settlement rules');
  set('probability', pct(m?.pUp)); $('probability-bar').style.width = `${Math.max(0, Math.min(100, (m?.pUp ?? 0) * 100))}%`;
  set('model-range', m ? `${pct(m.lowerUp)} – ${pct(m.upperUp)}` : '—');
  set('scenario-probabilities', m?.settlement?.ready ? `${pct(m.settlement.gaussian)} / ${pct(m.settlement.heavyTail)}` : '—');
  set('edges', m ? `${pct(m.edges?.[0])} / ${pct(m.edges?.[1])}` : '—');
  set('volatility', m?.settlement?.ready ? pct(m.settlement.sigmaLog) : '—');
  set('decision-state', data.settings.paused ? 'ENTRIES PAUSED' : m?.ready ? 'WATCHING FOR VALUE' : 'OBSERVING');
  set('decision', data.decision); set('model-reason', m?.reason || btc.status);
  book('up-book', data.books?.[0]); book('down-book', data.books?.[1]);
  set('up-spread', data.books?.[0] ? `${(data.books[0].spread * 100).toFixed(1)}¢ spread` : '—'); set('down-spread', data.books?.[1] ? `${(data.books[1].spread * 100).toFixed(1)}¢ spread` : '—');
  positions(data.positions); activity(data.events);
  $('pause').disabled = false; set('pause', data.settings.paused ? 'Resume entries' : 'Pause entries');
  if (!initializedSettings || !editing) { for (const [id, key, factor] of [['take-profit','takeProfit',100],['stop-loss','stopLoss',100],['trailing-stop','trailingStop',100],['max-hold','maxHoldSeconds',1]]) $(id).value = Math.round(data.settings[key] * factor); initializedSettings = true; }
  if (data.history) points = data.history;
  else if (btc.timestamp && points.at(-1)?.time !== btc.timestamp) points.push({ time: btc.timestamp, price: btc.price });
  points = points.slice(-300); draw(); tick();
}
function draw() {
  if (document.hidden) return;
  const canvas = $('chart'), rect = canvas.getBoundingClientRect(), dpi = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpi); canvas.height = Math.round(rect.height * dpi);
  const ctx = canvas.getContext('2d'); ctx.scale(dpi, dpi);
  const w = rect.width, h = rect.height, values = points.filter(p => Number.isFinite(p.price)), target = current.market?.settlement?.threshold;
  $('chart-empty').hidden = values.length > 1;
  if (values.length < 2) return;
  const prices = values.map(p => p.price); if (Number.isFinite(target)) prices.push(target);
  let lo = Math.min(...prices), hi = Math.max(...prices); const pad = Math.max(2, (hi - lo) * 0.15); lo -= pad; hi += pad;
  const left = 4, right = w - 65, top = 14, bottom = h - 27, first = values[0].time, span = Math.max(1000, values.at(-1).time - first);
  const x = time => left + (time - first) / span * (right - left), y = price => bottom - (price - lo) / (hi - lo) * (bottom - top);
  ctx.font = '9px ui-monospace,monospace'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const price = lo + (hi - lo) * i / 3, lineY = y(price); ctx.strokeStyle = '#242a33'; ctx.beginPath(); ctx.moveTo(left, lineY); ctx.lineTo(right, lineY); ctx.stroke(); ctx.fillStyle = '#687484'; ctx.fillText(Math.round(price).toLocaleString(), right + 10, lineY + 3); }
  if (Number.isFinite(target)) { ctx.strokeStyle = '#7c8798'; ctx.setLineDash([4,5]); ctx.beginPath(); ctx.moveTo(left,y(target)); ctx.lineTo(right,y(target)); ctx.stroke(); ctx.setLineDash([]); }
  const gradient = ctx.createLinearGradient(0,top,0,bottom); gradient.addColorStop(0,'#ff9b5720'); gradient.addColorStop(1,'#ff9b5700');
  ctx.beginPath(); values.forEach((p,i)=>i?ctx.lineTo(x(p.time),y(p.price)):ctx.moveTo(x(p.time),y(p.price))); ctx.lineTo(right,bottom); ctx.lineTo(left,bottom); ctx.closePath(); ctx.fillStyle=gradient;ctx.fill();
  ctx.strokeStyle='#ff9b57';ctx.lineWidth=1.7;ctx.beginPath();values.forEach((p,i)=>i?ctx.lineTo(x(p.time),y(p.price)):ctx.moveTo(x(p.time),y(p.price)));ctx.stroke();
  const end=values.at(-1);ctx.beginPath();ctx.arc(x(end.time),y(end.price),3,0,Math.PI*2);ctx.fillStyle='#ffad74';ctx.fill();
  ctx.fillStyle='#687484';ctx.fillText(new Date(first).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),left,h-7);ctx.fillText(new Date(end.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),Math.max(left,right-40),h-7);
}
function tick() {
  const seconds = current.market ? Math.max(0, Math.ceil((current.market.end - Date.now())/1000)) : null;
  set('countdown',seconds===null?'—':`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`);
  const age=lastReceived?(Date.now()-lastReceived)/1000:Infinity;
  $('stale').hidden=age<=8||!lastReceived;set('last-update',lastReceived?`Updated ${Math.floor(age)}s ago · Raspberry Pi ready`:'Waiting for data');
  if(age>8&&lastReceived){set('connection','Dashboard disconnected');$('connection-dot').classList.remove('ok');$('pause').disabled=true;}
}
$('pause').addEventListener('click',async()=>{const action=current.settings.paused?'resume':'pause';try{await control({action});toast(action==='resume'?'Entries resumed':'Entries paused; protective exits remain active');}catch(e){toast(e.message);}});
$('settings-form').addEventListener('input',()=>{editing=true;});
$('settings-form').addEventListener('submit',async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));try{await control({action:'settings',settings:{takeProfit:Number(values.takeProfit)/100,stopLoss:Number(values.stopLoss)/100,trailingStop:Number(values.trailingStop)/100,maxHoldSeconds:Number(values.maxHoldSeconds)}});editing=false;set('settings-feedback','Exit plan saved. Applies to open positions.');}catch(e){set('settings-feedback',e.message);}});
window.addEventListener('resize',draw);document.addEventListener('visibilitychange',()=>{if(!document.hidden)draw();});setInterval(tick,1000);
const source = new EventSource('/api/events');source.onmessage=event=>{try{render(JSON.parse(event.data));}catch{toast('Unable to render the latest snapshot');}};source.onerror=()=>{set('connection','Reconnecting…');$('connection-dot').classList.remove('ok');};
