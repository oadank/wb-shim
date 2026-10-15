// wb-shim 协议转换层：把 Anthropic Messages / OpenAI Responses 两种协议
// 转成上游只认的 OpenAI chat/completions，再把结果转回目标协议。
//
// 🔴 设计原则（老大 2026-10-15 问明）：转换按【路径】分，不按【模型】分。
//    三条路径共用同一份模型目录，glm-5.3-flash / hy3 / deepseek-v4-pro 谁都能走任一条：
//      POST /v1/chat/completions → OpenAI chat（原有路由，本文件不碰）
//      POST /v1/messages        → Anthropic Messages（claude bot 等）
//      POST /v1/responses       → OpenAI Responses（codex bot 等）
//    不存在"某模型只能配某条路"这回事。
//
// 🔴 关于流式（2026-10-15 实测修正）：
//    上游插件 shim 恒吐 SSE，**不看 body 里的 stream 参数**（传 false 也吐 SSE，
//    带头还有 `: heartbeat` 注释行）。所以正确姿势是：发 stream:false 表意，
//    拿到 SSE 后用 aggregateSseToChat 聚合成标准 chat.completion JSON，
//    再按目标协议合成流式/非流式返回。daemon.mjs 的 chat 路由也是这么干的。
const CHUNK = 24; // 合成流式时每片字符数

/* ── 上游 SSE → chat.completion JSON ── */
export async function aggregateSseToChat(up) {
  const buf = { text: '', calls: [], finish: null, id: null, model: null, usage: null };
  const callIdx = {}; // 上游 tool_call index → buf.calls 下标
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of up) {
    pending += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = pending.indexOf('\n\n')) >= 0) {
      const raw = pending.slice(0, nl);
      pending = pending.slice(nl + 2);
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue; // 跳过 ": heartbeat" 注释行与空行
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (!buf.id && j.id) buf.id = j.id;
        if (!buf.model && j.model) buf.model = j.model;
        if (j.usage) buf.usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        if (ch.finish_reason) buf.finish = ch.finish_reason;
        const d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) buf.text += d.content;
        // reasoning_content 忽略：思考型模型的思考过程不算正文
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const key = tc.index ?? 0;
            if (callIdx[key] === undefined) {
              callIdx[key] = buf.calls.length;
              buf.calls.push({ id: tc.id || ('call_' + key), function: { name: '', arguments: '' } });
            }
            const slot = buf.calls[callIdx[key]];
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.function.name += tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }
  return {
    id: buf.id || 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: buf.model,
    choices: [{
      index: 0,
      finish_reason: buf.finish || (buf.calls.length ? 'tool_calls' : 'stop'),
      message: {
        role: 'assistant',
        content: buf.text || null,
        ...(buf.calls.length ? { tool_calls: buf.calls } : {}),
      },
    }],
    ...(buf.usage ? { usage: buf.usage } : {}),
  };
}

/* ── 请求转换 ── */

/** Anthropic /v1/messages body → chat/completions body */
export function anthropicToChat(b) {
  const msgs = [];
  // system 可能是字符串或 block 数组
  if (b.system) {
    const s = typeof b.system === 'string'
      ? b.system
      : (b.system || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    if (s) msgs.push({ role: 'system', content: s });
  }
  for (const m of b.messages || []) {
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // tool_result 块转成 user 文本（工具回填），text 块直接取文字
      const parts = [];
      for (const c of m.content) {
        if (!c) continue;
        if (c.type === 'text') parts.push(c.text);
        else if (c.type === 'tool_result') {
          const t = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
          parts.push(t);
        }
      }
      content = parts.join('\n');
    } else {
      content = '';
    }
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content || '' });
  }
  const out = {
    model: b.model,
    messages: msgs,
    max_tokens: b.max_tokens ?? 4096,
    stream: false,
  };
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.top_p !== undefined) out.top_p = b.top_p;
  // 工具：OpenAI function 与 Anthropic tool 结构基本同构，直接改名透传
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
    }));
  }
  return out;
}

/** OpenAI Responses body → chat/completions body */
export function responsesToChat(b) {
  const msgs = [];
  if (b.instructions) msgs.push({ role: 'system', content: b.instructions });
  const inp = b.input;
  if (typeof inp === 'string') {
    msgs.push({ role: 'user', content: inp });
  } else if (Array.isArray(inp)) {
    for (const it of inp) {
      if (!it || typeof it !== 'object') continue;
      if (!it.role) continue; // 跳过非消息项（如 reasoning item）
      let c = it.content;
      if (typeof c === 'string') {
        // 保持
      } else if (Array.isArray(c)) {
        c = c.filter((x) => x && (x.type === 'input_text' || x.type === 'output_text' || x.type === 'text'))
          .map((x) => x.text ?? '').join('\n');
      } else {
        c = '';
      }
      msgs.push({ role: it.role === 'system' || it.role === 'developer' ? 'system' : it.role, content: c || '' });
    }
  }
  const mo = b.max_output_tokens;
  const out = {
    model: b.model,
    messages: msgs,
    max_tokens: mo ?? 4096,
    stream: false,
  };
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.top_p !== undefined) out.top_p = b.top_p;
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => (t.type === 'function'
      ? t
      : { type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } } }));
  }
  return out;
}

/* ── 响应转换：chat.completion JSON → 目标协议 SSE ── */

/** 从上游 chat 响应里取出正文 + 工具调用（若有） */
function extract(chat) {
  const ch = (chat.choices && chat.choices[0]) || {};
  const msg = ch.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  return { text, calls, finish: ch.finish_reason, usage: chat.usage || {} };
}

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** → Anthropic Messages SSE */
export function chatToAnthropicSSE(res, chat, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const { text, calls, finish, usage } = extract(chat);
  const stopReason = finish === 'length' ? 'max_tokens' : (calls.length ? 'tool_use' : 'end_turn');
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: chat.id || 'msg_' + Date.now(),
      type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0 },
    },
  });
  let idx = 0;
  if (text) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < text.length; i += CHUNK) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: text.slice(i, i + CHUNK) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    idx++;
  }
  for (const c of calls) {
    const fn = c.function || {};
    let input = {};
    try { input = JSON.parse(fn.arguments || '{}'); } catch { /* 参数畸形就给空对象 */ }
    sse(res, 'content_block_start', {
      type: 'content_block_start', index: idx,
      content_block: { type: 'tool_use', id: c.id || 'toolu_' + Date.now(), name: fn.name || '', input },
    });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    idx++;
  }
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.completion_tokens || 0 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/** → OpenAI Responses SSE */
export function chatToResponsesSSE(res, chat, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const { text, calls, usage } = extract(chat);
  const id = chat.id || 'resp_' + Date.now();
  const s = (t, d) => sse(res, t, { ...d, type: t });
  const output = [];
  s('response.created', { response: { id, model, status: 'in_progress', output: [] } });
  if (text) {
    s('response.output_item.added', { output_index: 0, item: { id: 'msg_0', type: 'message', role: 'assistant', content: [] } });
    s('response.content_part.added', { item_id: 'msg_0', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
    for (let i = 0; i < text.length; i += CHUNK) {
      s('response.output_text.delta', { item_id: 'msg_0', output_index: 0, content_index: 0, delta: text.slice(i, i + CHUNK) });
    }
    s('response.content_part.done', { item_id: 'msg_0', output_index: 0, content_index: 0, part: { type: 'output_text', text } });
    s('response.output_item.done', { output_index: 0, item: { id: 'msg_0', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } });
    output.push({ id: 'msg_0', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
  }
  // 工具调用 → function_call item
  let oi = text ? 1 : 0;
  for (const c of calls) {
    const fn = c.function || {};
    const itemId = 'fc_' + (c.id || oi);
    s('response.output_item.added', { output_index: oi, item: { id: itemId, type: 'function_call', name: fn.name || '', arguments: '', call_id: c.id || itemId, status: 'in_progress' } });
    s('response.function_call_arguments.delta', { item_id: itemId, output_index: oi, delta: fn.arguments || '' });
    s('response.function_call_arguments.done', { item_id: itemId, output_index: oi, arguments: fn.arguments || '' });
    s('response.output_item.done', { output_index: oi, item: { id: itemId, type: 'function_call', name: fn.name || '', arguments: fn.arguments || '', call_id: c.id || itemId, status: 'completed' } });
    output.push({ id: itemId, type: 'function_call', name: fn.name || '', arguments: fn.arguments || '', call_id: c.id || itemId, status: 'completed' });
    oi++;
  }
  s('response.completed', {
    response: {
      id, model, status: 'completed', output,
      usage: usage.prompt_tokens !== undefined
        ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
        : null,
    },
  });
  res.end();
}

/** 非流式直出：Anthropic Messages JSON */
export function chatToAnthropicJson(res, chat, model) {
  const { text, calls, finish, usage } = extract(chat);
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls) {
    let input = {};
    try { input = JSON.parse((c.function || {}).arguments || '{}'); } catch { /* 见上 */ }
    content.push({ type: 'tool_use', id: c.id || 'toolu_' + Date.now(), name: (c.function || {}).name || '', input });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: chat.id || 'msg_' + Date.now(),
    type: 'message', role: 'assistant', model,
    content,
    stop_reason: finish === 'length' ? 'max_tokens' : (calls.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  }));
}

/** 非流式直出：Responses JSON */
export function chatToResponsesJson(res, chat, model) {
  const { text, calls, usage } = extract(chat);
  const output = [];
  if (text) output.push({ id: 'msg_0', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
  for (const c of calls) {
    output.push({ id: 'fc_' + (c.id || ''), type: 'function_call', name: (c.function || {}).name || '', arguments: (c.function || {}).arguments || '', call_id: c.id || '', status: 'completed' });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: chat.id || 'resp_' + Date.now(),
    object: 'response', created_at: Math.floor(Date.now() / 1000),
    model, status: 'completed', output,
    usage: usage.prompt_tokens !== undefined
      ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
      : null,
  }));
}
