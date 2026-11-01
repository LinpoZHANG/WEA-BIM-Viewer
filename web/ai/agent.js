/* WEA AI — designer agent loop (provider-neutral).
 * Messages: { role: 'system'|'user'|'assistant'|'tool', content?, tool_calls?: [{ id, name, arguments }], tool_call_id? }
 * Provider: { id, label, async next({ messages, tools, signal }) -> { content?, tool_calls?, usage? } }
 * The loop executes tool calls through DesignTools and feeds the results back until the provider
 * answers without tool calls (or the step budget runs out). History is kept for follow-up requests
 * ("方案 2 再暖一点") so the conversation continues on the same drafts.
 */
import { TOOL_DEFS } from './tools.js';
import { SYSTEM_PROMPT } from './prompt.js';

export class DesignAgent {
  constructor({ tools, provider, maxSteps = 80, onEvent = () => {} }) {
    this.tools = tools; this.provider = provider; this.maxSteps = maxSteps; this.onEvent = onEvent;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.usage = { input: 0, output: 0, calls: 0 };
  }
  setProvider(p) { this.provider = p; }
  async send(text, { signal } = {}) {
    this.messages.push({ role: 'user', content: text });
    const ctx = this.tools.ws.room ? `（当前房间：${this.tools.ws.room.name}，id ${this.tools.ws.room.id}）` : '';
    if (ctx) this.messages.at(-1).content += '\n' + ctx;
    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) throw new Error('已停止');
      this.onEvent({ type: 'thinking', step });
      const res = await this.provider.next({ messages: this.messages, tools: TOOL_DEFS, signal });
      this.usage.calls++;
      if (res.usage) { this.usage.input += res.usage.input || 0; this.usage.output += res.usage.output || 0; }
      const calls = res.tool_calls || [];
      this.messages.push({ role: 'assistant', content: res.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (res.content) this.onEvent({ type: calls.length ? 'note' : 'answer', text: res.content });
      if (!calls.length) return res.content || '';
      for (const c of calls) {
        if (signal?.aborted) throw new Error('已停止');
        this.onEvent({ type: 'tool', name: c.name, args: c.arguments });
        const out = c.parseError ? { ok: false, error: '参数不是有效 JSON：' + c.parseError } : await this.tools.call(c.name, c.arguments);
        this.onEvent({ type: 'tool-result', name: c.name, result: out });
        this.messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: JSON.stringify(out) });
      }
    }
    throw new Error(`超过 ${this.maxSteps} 步仍未完成，已停止（可继续对话让它收尾）`);
  }
}
