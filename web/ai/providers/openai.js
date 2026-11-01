/* WEA AI — OpenAI provider (Chat Completions function calling) via the local proxy /api/ai/chat.
 * The browser never sees the API key: tools/ai_proxy.py adds model + credentials.
 * Converts the agent's neutral messages / tool definitions to the OpenAI shape and back.
 * NOTE: not exercised against the live API yet (no key configured); conversion is unit-tested.
 */
export function toOpenAI(messages, tools) {
  return {
    messages: messages.map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      if (m.role === 'assistant' && m.tool_calls?.length) return { role: 'assistant', content: m.content ?? null,
        tool_calls: m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) };
      return { role: m.role, content: m.content ?? '' };
    }),
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: 'auto',
  };
}

export function fromOpenAI(resp) {
  const msg = resp?.choices?.[0]?.message;
  if (!msg) throw new Error('OpenAI 返回内容为空');
  const tool_calls = (msg.tool_calls || []).filter(c => c.type === 'function').map(c => {
    let args = {}, parseError = null;
    try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch (e) { parseError = e.message; }
    return { id: c.id, name: c.function.name, arguments: args, ...(parseError ? { parseError } : {}) };
  });
  const u = resp.usage || {};
  return { content: msg.content || null, tool_calls, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 } };
}

export const openaiProvider = {
  id: 'openai', label: 'OpenAI',
  async next({ messages, tools, signal }) {
    const r = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toOpenAI(messages, tools)), signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `AI 服务错误（${r.status}）`);
    return fromOpenAI(data);
  },
};
