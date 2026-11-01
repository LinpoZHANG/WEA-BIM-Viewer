/* WEA MEP Routing workspace.
 * Input: the lighting design held by the Lighting Design workspace (viewer.lighting.state), read-only
 * except for the ELV settings stored in it. Output: ELV drawings (tools/elv_drawings.py via
 * POST /api/lighting/elv). Shares the BIM scene; owns only its panels.
 * The three workspaces are exclusive: BIM Model Explorer (default), Lighting Design, MEP Routing.
 */
const $ = s => document.querySelector(s);

export class RoutingWorkspace {
  constructor(viewer) {
    this.v = viewer; this.active = false;
    $('#routingButton').onclick = () => this.enter();
    $('#moduleBim').onclick = () => { this.exit(); this.lighting?.exit(); this.tabs('moduleBim'); };
    $('#moduleLighting').onclick = () => { this.exit(); this.lighting?.enter(); };
    $('#rtScheme').onchange = e => { const d = this.design; if (!d) return; this.lighting.activateScheme(e.target.value); this.render(); };
    $('#elvExport').onclick = () => this.exportElv();
    $('#elvReopen').onclick = () => this.openPreview();
    $('#elvClose').onclick = () => { $('#elvPreview').hidden = true; };
    $('#elvFit').onclick = () => this.fit();
    $('#elvDownload').onclick = () => this.download();
    this.wirePanZoom();
    const setElv = (key, v, ok) => { if (!ok) { this.v.toast('数值超出范围'); this.render(); return; } this.lighting.state.commit('elv', d => { d.elvSettings[key] = v; }); this.render(); };
    $('#elvVoltage').onchange = e => setElv('lvVoltage', +e.target.value, true);
    $('#elvDrop').onchange = e => { const v = +e.target.value; setElv('dropLimit', v, v >= 1 && v <= 10); };
    $('#elvPanelH').onchange = e => { const v = +e.target.value; setElv('panelHeight', v, v >= 0.9 && v <= 1.8); };
    $('#elvMaxI').onchange = e => { const v = +e.target.value; setElv('maxCurrent', v, v >= 2 && v <= 16); };
    $('#elvMaxRooms').onchange = e => { const v = Math.round(+e.target.value); setElv('maxRooms', v, v >= 1 && v <= 30); };
    $('#elvCable').onchange = e => { const v = e.target.value.trim(); setElv('cable', v, /\{s\}/.test(v)); };
    $('#elvConduit').onchange = e => { const v = e.target.value.trim(); setElv('conduit', v, v.length > 0 && v.length < 16); };
  }
  get lighting() { return this.v.lighting; }
  get design() { return this.lighting?.state?.design; }
  tabs(id) { ['moduleBim', 'moduleLighting', 'routingButton'].forEach(t => $('#' + t).classList.toggle('active', t === id)); }
  enter() {
    if (!this.lighting?.ready) { this.v.toast('模型或照明方案尚未载入'); return; }
    this.lighting.exit();
    this.active = true; document.body.classList.add('ws-routing'); this.tabs('routingButton');
    document.querySelectorAll('.sidebar').forEach(el => el.scrollTop = 0);
    this.v.home();                                   // leave the lighting close-up: whole-model overview
    this.render();
  }
  exit() {
    if (!this.active) return;
    this.active = false; document.body.classList.remove('ws-routing'); this.tabs('moduleBim'); $('#elvPreview').hidden = true;
  }

  /* ---------- drawing preview: SVGs rendered server-side from the same DXF files ---------- */
  openPreview(sheet = this.sheet) {
    if (!this.output) return;
    const names = Object.keys(this.output.svgs); this.sheet = names.includes(sheet) ? sheet : names[0];
    $('#elvTabs').innerHTML = names.map(n => `<button data-sheet="${this.v.safe(n)}" class="${n === this.sheet ? 'active' : ''}">${this.v.safe(n.replace(/\.dxf$/, '').replace(/^\d+_/, ''))}</button>`).join('');
    $('#elvTabs').querySelectorAll('[data-sheet]').forEach(b => b.onclick = () => this.openPreview(b.dataset.sheet));
    const host = $('#elvSheet'); host.innerHTML = this.output.svgs[this.sheet];
    const svg = host.querySelector('svg');
    const vb = svg.viewBox.baseVal; this.sheetSize = [vb.width, vb.height];
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('width', vb.width); svg.setAttribute('height', vb.height);   // 1 user unit = 1 px, scaled by the transform
    $('#elvPreview').hidden = false; this.fit();
  }
  fit() {
    if (!this.sheetSize) return;
    const c = $('#elvCanvas').getBoundingClientRect(), [w, h] = this.sheetSize;
    const k = Math.min(c.width / w, c.height / h) * 0.96;
    this.view = { k, x: (c.width - w * k) / 2, y: (c.height - h * k) / 2 }; this.applyView();
  }
  applyView() { const v = this.view; $('#elvSheet').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`; }
  wirePanZoom() {
    const c = $('#elvCanvas'); let drag = null;
    c.addEventListener('wheel', e => {
      e.preventDefault(); if (!this.view) return;
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = Math.exp(-e.deltaY * 0.0015);
      const v = this.view, k = Math.min(Math.max(v.k * f, 1e-3), 50);
      v.x = mx - (mx - v.x) * k / v.k; v.y = my - (my - v.y) * k / v.k; v.k = k; this.applyView();
    }, { passive: false });
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => { if (!drag || !this.view) return; this.view.x += e.clientX - drag.x; this.view.y += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; this.applyView(); });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('dblclick', () => this.fit());
    window.addEventListener('resize', () => { if (!$('#elvPreview').hidden) this.fit(); });
  }
  download() {
    if (!this.output) return;
    const bin = Uint8Array.from(atob(this.output.zip), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bin], { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = (this.v.model.name || 'model') + '_弱电图纸.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  render() {
    const d = this.design; if (!d) return;
    const safe = this.v.safe, scheme = d.schemes[d.activeScheme], rooms = new Map();
    for (const f of scheme.fixtures) if (f.roomId) rooms.set(f.roomId, (rooms.get(f.roomId) || 0) + 1);
    const names = new Map(this.lighting.rooms.map(r => [r.id, r.name]));
    $('#rtSource').innerHTML = `<div class="data-row"><span>数据来源</span><strong>Lighting Design · ${safe(scheme.name)}</strong></div>
      <div class="data-row"><span>灯具</span><strong>${scheme.fixtures.length} 盏 · ${rooms.size} 个房间</strong></div>
      <div class="data-row"><span>房间</span><strong>${[...rooms].map(([id, n]) => `${safe(names.get(id) || id)} ${n}`).join('，') || '—'}</strong></div>
      ${this.lighting.state.dirty ? '<div class="lt-note">照明方案有未保存的修改；出图使用当前（含未保存）内容。</div>' : ''}`;
    $('#rtScheme').innerHTML = Object.entries(d.schemes).map(([id, s]) => `<option value="${id}" ${id === d.activeScheme ? 'selected' : ''}>${safe(s.name)}（${s.fixtures.length} 盏）</option>`).join('');
    const es = d.elvSettings || {};
    $('#elvVoltage').value = String(es.lvVoltage ?? 24); $('#elvDrop').value = es.dropLimit ?? 3; $('#elvPanelH').value = es.panelHeight ?? 1.3;
    $('#elvMaxI').value = es.maxCurrent ?? 10; $('#elvMaxRooms').value = es.maxRooms ?? 8; $('#elvCable').value = es.cable ?? 'BV-3×{s}'; $('#elvConduit').value = es.conduit ?? 'PC20';
    $('#elvBoardNote').innerHTML = es.board?.world ? '配电箱 AL1：已在平面定位中指定位置。' : '配电箱 AL1：未指定，出图时自动放在入户门旁（需确认）；可在 Lighting Design → 平面定位 → “配电箱”中指定。线缆中的 {s} 为自动选择的截面。';
  }
  /** ELV drawings: lighting control + low-voltage supply as DXF, from the current (unsaved) lighting design. */
  async exportElv() {
    const btn = $('#elvExport'); btn.disabled = true; btn.textContent = '生成中…';
    try {
      const r = await fetch('/api/lighting/elv', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: this.design, settings: this.design.elvSettings }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || '生成失败');
      this.output = data; this.openPreview(); $('#elvReopen').hidden = false;
      const s = data.summary, safe = this.v.safe;
      const m = s.mains;
      $('#elvResult').innerHTML = `<div class="lt-ok">已生成 ${Object.keys(data.svgs).length} 张 DXF，并保存到项目 ${safe(data.folder)}（预览中可下载 zip）</div>` + s.rooms.map(r => `<div class="data-row"><span>${safe(r.code)} ${safe(r.name)}</span><strong>${r.groups.map(g => `${safe(g.id)} ${safe(g.name)}×${g.fixtures}`).join('，')}${r.drivers.length ? '<br>' + r.drivers.map(d => `${safe(d.id)} ${d.voltage}V ${d.rating}W，最大压降 ${d.maxDropPct.toFixed(1)}%`).join('<br>') : ''}<br><small>面板：${safe(r.panel)}</small></strong></div>`).join('')
        + (m ? `<div class="lt-sub">强电照明回路 · 配电箱 AL1（${safe(m.board.note)}）</div>` + m.circuits.map(c => `<div class="data-row"><span>${safe(c.id)} <small>${c.fixtures} 个负载</small></span><strong>${safe(c.label.split(' ').slice(1).join(' '))}<br>${c.power.toFixed(0)} W · ${c.current.toFixed(2)} A · ${c.length.toFixed(1)} m · ΔU ${c.drop.toFixed(2)}%<br><small>${safe(c.rooms.join('、'))}</small></strong></div>`).join('') : '')
        + (s.warnings.length ? `<div class="lt-warn">需人工确认：${s.warnings.map(safe).join('；')}</div>` : '');
      this.v.toast('电气图纸已生成，正在预览');
    } catch (err) { this.v.toast('弱电图纸生成失败：' + err.message); }
    finally { btn.disabled = false; btn.textContent = '生成并预览电气图纸'; }
  }
}
