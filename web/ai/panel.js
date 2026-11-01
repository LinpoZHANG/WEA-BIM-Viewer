/* WEA AI — designer chat panel in the Lighting Design workspace.
 * Conversation on the left of the inspector; every finished scheme becomes a card that opens the
 * scheme in the viewer (3D / plan), or sends it to MEP Routing for drawings. Provider: offline demo
 * (rule script) or OpenAI through the local proxy (needs config/ai.local.json).
 */
import { DesignAgent } from './agent.js';
import { DesignTools } from './tools.js';
import { demoProvider } from './providers/demo.js';
import { openaiProvider } from './providers/openai.js';

const $ = s => document.querySelector(s);
const EXAMPLE = '我要一个明亮温馨风格的客厅，架设八个射灯和一个装饰吊灯';
const TOOL_LABELS = { get_project_overview: '读取项目', get_room_context: '读取房间', get_design_targets: '查标准与目标', list_fixture_types: '查灯具库',
  create_scheme: '新建方案', place_fixtures: '放置灯具', layout_grid: '行列均布', layout_along_wall: '沿墙布置', place_over_object: '对象上方布灯',
  update_fixtures: '调整灯具', remove_fixtures: '删除灯具', evaluate_scheme: '计算照度', finalize_scheme: '完成方案' };

export class AiPanel {
  constructor(ws) {
    this.ws = ws; this.v = ws.v; this.busy = null; this.status = null;
    this.providers = { demo: demoProvider(), openai: openaiProvider };
    this.providerId = 'demo';
    $('#ltAiToggle').onclick = () => this.toggle();
    $('#aiClose').onclick = () => this.toggle(false);
    $('#aiSend').onclick = () => this.busy ? this.busy.abort() : this.send();
    $('#aiInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!this.busy) this.send(); } });
    $('#aiExample').onclick = () => { $('#aiInput').value = EXAMPLE; $('#aiInput').focus(); };
    $('#aiProvider').onchange = e => { this.providerId = e.target.value; this.agent?.setProvider(this.providers[this.providerId]); this.renderStatus(); };
    $('#aiReset').onclick = () => { this.agent = null; $('#aiLog').innerHTML = ''; this.renderStatus(); };
    this.v.events.addEventListener('schemechange', () => this.markActive());
  }
  toggle(on = $('#aiPanel').hidden) {
    $('#aiPanel').hidden = !on; $('#ltAiToggle').classList.toggle('active', on);
    document.body.classList.toggle('ws-ai', on);
    if (on) { this.refreshStatus(); $('#aiInput').focus(); }
  }
  async refreshStatus() {
    try { this.status = await (await fetch('/api/ai/status', { cache: 'no-store' })).json(); } catch { this.status = null; }
    const o = this.status?.openai;
    $('#aiProvider').querySelector('[value="openai"]').textContent = o?.configured ? `OpenAI · ${o.model}` : 'OpenAI（未配置）';
    this.renderStatus();
  }
  renderStatus() {
    const o = this.status?.openai, el = $('#aiStatus');
    if (this.providerId === 'demo') el.innerHTML = '<b>离线演示</b>：规则脚本驱动与真实 AI 相同的工具（读取房间 → 布灯 → 计算 → 修正 → 完成），用于演示流程，<b>不是大模型</b>。';
    else if (o?.configured) el.innerHTML = `<b>OpenAI · ${this.v.safe(o.model)}</b>：房间与方案的结构化摘要会发送到 OpenAI（不发送 IFC 原文件）。`;
    else el.innerHTML = `<b>OpenAI 未配置</b>：${this.v.safe(o?.reason || '服务不可用')}。复制 <code>config/ai.example.json</code> 为 <code>config/ai.local.json</code> 并填写 apiKey 与 model，重启服务。`;
  }

  /* ---------- conversation ---------- */
  log(html, cls) { const d = document.createElement('div'); d.className = 'ai-msg ' + cls; d.innerHTML = html; $('#aiLog').appendChild(d); $('#aiLog').scrollTop = 1e9; return d; }
  async send() {
    const text = $('#aiInput').value.trim(); if (!text) return;
    if (!this.ws.ready || !this.ws.room) { this.v.toast('模型或房间尚未就绪'); return; }
    if (this.providerId === 'openai' && !this.status?.openai?.configured) { this.v.toast('OpenAI 尚未配置，请先使用离线演示'); return; }
    $('#aiInput').value = '';
    this.log(this.v.safe(text), 'ai-user');
    if (!this.agent) {
      this.tools = new DesignTools(this.ws, { source: this.providerId === 'demo' ? 'demo' : 'ai', onEvent: e => this.onToolEvent(e) });
      this.agent = new DesignAgent({ tools: this.tools, provider: this.providers[this.providerId], onEvent: e => this.onAgentEvent(e) });
    }
    this.tools.source = this.providerId === 'demo' ? 'demo' : 'ai';
    this.steps = this.log('<details><summary>工具调用 <span>0</span> 步</summary><ol></ol></details>', 'ai-steps'); this.stepCount = 0;
    this.busy = new AbortController(); $('#aiSend').textContent = '停止'; $('#aiSend').classList.add('busy');
    const t0 = performance.now();
    try {
      const answer = await this.agent.send(text, { signal: this.busy.signal });
      this.log(md(this.v.safe(answer)), 'ai-bot');
    } catch (err) { this.log('⚠ ' + this.v.safe(err.message), 'ai-err'); }
    finally {
      this.busy = null; $('#aiSend').textContent = '发送'; $('#aiSend').classList.remove('busy');
      const u = this.agent.usage;
      $('#aiUsage').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s · ${this.stepCount} 步${u.input ? ` · tokens ${u.input} / ${u.output}` : ''}`;
    }
  }
  onAgentEvent(e) {
    if (e.type === 'tool') {
      this.stepCount++; this.steps.querySelector('summary span').textContent = this.stepCount;
      const li = document.createElement('li'); li.textContent = `${TOOL_LABELS[e.name] || e.name} ${brief(e.args)}`; this.steps.querySelector('ol').appendChild(li); this.lastStep = li;
    } else if (e.type === 'tool-result' && this.lastStep) {
      const r = e.result;
      this.lastStep.classList.toggle('bad', !r.ok || !!r.errors?.length);
      this.lastStep.title = JSON.stringify(r).slice(0, 600);
      if (e.name === 'evaluate_scheme' && r.ok) this.lastStep.textContent += r.rooms ? ` → ${r.passed}/${r.total} 个房间达标` : ` → ${r.Eavg} lx · U0 ${r.U0 ?? '—'}${r.check?.pass ? ' ✓' : ''}`;
      if (e.name === 'place_in_rooms' && r.ok) this.lastStep.textContent += ` → 放置 ${r.placed.length}，跳过 ${r.skipped.length}`;
      if (!r.ok) this.lastStep.textContent += ` → ${r.error}`;
    } else if (e.type === 'note') this.log(md(this.v.safe(e.text)), 'ai-bot ai-note');
  }
  onToolEvent(e) {
    if (e.type === 'final') this.card(e);
    if (e.type === 'scheme' || e.type === 'design') { this.ws.renderScheme(); if (this.ws.state.design.activeScheme === e.schemeId) this.ws.onDesignChange(); }
  }

  /* ---------- scheme cards ---------- */
  card(e) {
    if (e.rooms) return this.multiCard(e);
    const { schemeId, roomId, scheme, evaluation: ev } = e;
    const safe = this.v.safe, room = this.ws.roomById(roomId);
    const counts = Object.entries(scheme.fixtures.filter(f => f.roomId === roomId).reduce((a, f) => (a[f.fixtureType] = (a[f.fixtureType] || 0) + 1, a), {}))
      .map(([t, n]) => `${this.ws.FIXTURE_TYPES[t].label} ×${n}`).join('，');
    const el = this.log(`<div class="ai-card" data-scheme="${schemeId}">
      <div class="ai-card-head"><b>${safe(scheme.name)}</b><em class="${ev.check.pass ? 'ok' : 'warn'}">${ev.check.pass ? '达标' : '部分未达标'}</em></div>
      <div class="ai-kpis"><span><b>${ev.Eavg}</b> lx</span><span>U0 <b>${ev.U0 ?? '—'}</b>${ev.targets?.U0 == null ? '（不考核）' : ''}</span><span><b>${ev.lpd_w_m2}</b> W/m²</span><span><b>${ev.cct.join('/')}</b> K</span></div>
      <div class="ai-card-sub">${safe(room?.name || '')} · ${safe(counts)}</div>
      <p>${safe(scheme.rationale || '')}</p>
      ${scheme.assumptions?.length ? `<ul>${scheme.assumptions.map(a => `<li>${safe(a)}</li>`).join('')}</ul>` : ''}
      <div class="lt-btns"><button data-act="open" class="lt-primary">在视图中打开</button><button data-act="plan">平面</button><button data-act="elv">出图</button></div></div>`, 'ai-cardwrap');
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => this.act(b.dataset.act, schemeId, roomId));
    this.markActive();
  }
  /** scheme covering several rooms: per-room table, opens in the whole-building view */
  multiCard({ schemeId, scheme, rooms }) {
    const safe = this.v.safe, passed = rooms.filter(r => r.pass).length, n = rooms.reduce((a, r) => a + r.fixtures, 0);
    const el = this.log(`<div class="ai-card" data-scheme="${schemeId}">
      <div class="ai-card-head"><b>${safe(scheme.name)}</b><em class="${passed === rooms.length ? 'ok' : 'warn'}">${passed}/${rooms.length} 间达标</em></div>
      <div class="ai-kpis"><span><b>${rooms.length}</b> 个房间</span><span><b>${n}</b> 盏</span></div>
      <p>${safe(scheme.rationale || '')}</p>
      <div class="ai-rooms">${rooms.map(r => `<div class="${r.pass ? '' : 'bad'}"><span>${safe(r.room)}</span><i>${r.Eavg} lx · U0 ${r.U0 ?? '—'}</i></div>`).join('')}</div>
      ${scheme.assumptions?.length ? `<ul>${scheme.assumptions.map(a => `<li>${safe(a)}</li>`).join('')}</ul>` : ''}
      <div class="lt-btns"><button data-act="global" class="lt-primary">全局查看</button><button data-act="elv">出图</button></div></div>`, 'ai-cardwrap');
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => this.act(b.dataset.act, schemeId, rooms[0]?.room_id));
    this.markActive();
  }
  act(what, schemeId, roomId) {
    const ws = this.ws;
    ws.activateScheme(schemeId);
    if (what === 'global') { ws.setView('global'); return; }
    if (ws.room?.id !== roomId) ws.selectRoom(roomId, what === 'plan' ? 'plan' : 'orbit');
    else ws.setView(what === 'plan' ? 'plan' : ws.view === 'plan' ? 'orbit' : ws.view);
    if (what === 'elv') { const rt = this.v.routing; if (!rt) return; this.toggle(false); rt.enter(); rt.exportElv(); }
  }
  markActive() { const id = this.ws.state.design?.activeScheme; document.querySelectorAll('.ai-card').forEach(c => c.classList.toggle('active', c.dataset.scheme === id)); }
}

const brief = a => {
  if (!a) return '';
  const keys = ['name', 'type', 'rows', 'cols', 'count', 'offset_mm', 'target', 'flux_lm', 'beam_deg', 'filter_type', 'styles'];
  const parts = keys.filter(k => a[k] != null && a[k] !== '').map(k => `${k}=${Array.isArray(a[k]) ? a[k].join('/') : a[k]}`);
  if (a.fixtures) parts.push(`${a.fixtures.length} 盏`);
  return parts.length ? `（${parts.join(' ')}）` : '';
};
const md = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
