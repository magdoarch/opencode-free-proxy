/**
 * OpenCode Free Tier Proxy — Vercel Serverless
 * Routes OpenAI-compatible requests to OpenCode's free tier by spoofing desktop client headers.
 *
 * Deploy: vercel deploy --prod
 * Usage: https://your-app.vercel.app/v1/chat/completions
 */

import crypto from "crypto";

const OPENCODE_BASE = "https://opencode.ai/zen/v1";
const OPENCODE_UA = "opencode/1.18.31";

// Free models available on OpenCode tier
const FREE_MODELS = new Set([
  "beam-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
  "space-bunny-free",
]);

// Models that use the /responses endpoint instead of /chat/completions
const RESPONSES_MODELS = new Set([]);

// Fingerprint tools required by OpenCode Free tier
const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

// ── ID generators (matches OpenCode desktop format) ──

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(len) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => BASE62[b % 62]).join("");
}

function generateSessionId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${randomBase62(14)}`;
}

function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${randomBase62(14)}`;
}

// ── Model list (cached) ──

let cachedModels = null;
let cacheTime = 0;

async function fetchModels() {
  const now = Date.now();
  if (cachedModels && now - cacheTime < 3600_000) return cachedModels;

  const models = Array.from(FREE_MODELS).map((id) => ({
    id,
    object: "model",
    created: Math.floor(now / 1000),
    owned_by: "opencode-free",
  }));

  cachedModels = models;
  cacheTime = now;
  return models;
}

// ── Main handler ──

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname;

  // ── GET /v1/models or /api/v1/models ──
  if (req.method === "GET" && (path.endsWith("/v1/models") || path === "/models")) {
    try {
      const models = await fetchModels();
      return res.status(200).json({ object: "list", data: models });
    } catch (e) {
      return res.status(502).json({ error: { message: e.message } });
    }
  }

  // ── GET /health ──
  if (req.method === "GET" && path.endsWith("/health")) {
    return res.status(200).json({ status: "ok", provider: "opencode-free" });
  }

  // ── POST /v1/chat/completions or /api/v1/chat/completions ──
  if (req.method === "POST" && (path.endsWith("/v1/chat/completions") || path.endsWith("/chat/completions"))) {
    const body = req.body || {};
    const model = body.model || "mimo-v2.6-flash-free";
    const wantStream = !!body.stream;

    if (!FREE_MODELS.has(model) && !req.headers["x-allow-any"]) {
      return res.status(400).json({
        error: {
          message: `Model '${model}' not available. Free models: ${[...FREE_MODELS].join(", ")}`,
          type: "invalid_request_error",
        },
      });
    }

    const sessionId = generateSessionId();
    const requestId = generateRequestId();

    try {
      if (RESPONSES_MODELS.has(model)) {
        return await forwardResponses(req, res, body, model, sessionId, requestId, wantStream);
      }
      return await forwardChat(req, res, body, model, sessionId, requestId, wantStream);
    } catch (e) {
      return res.status(502).json({ error: { message: e.message } });
    }
  }

  return res.status(404).json({ error: { message: "Not found" } });
}

// ── Forward to /chat/completions (Standard Chat Models) ──

async function forwardChat(req, res, body, model, sessionId, requestId, stream) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer public",
    "x-opencode-client": "desktop",
    "x-opencode-session": sessionId,
    "x-opencode-request": requestId,
    "x-opencode-project": "global",
    "Accept": "text/event-stream",
    "User-Agent": OPENCODE_UA,
  };

  const payload = { ...body, model, stream: true };

  // Ensure fingerprint quartet exists in tools
  if (!payload.tools || !payload.tools.length) {
    payload.tools = FINGERPRINT_TOOLS.map((name) => ({
      type: "function",
      function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
    }));
  } else {
    const existingNames = new Set(payload.tools.map((t) => (t.function?.name || t.name || "").toLowerCase()));
    for (const name of FINGERPRINT_TOOLS) {
      if (!existingNames.has(name)) {
        payload.tools.push({
          type: "function",
          function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
        });
      }
    }
  }

  const upstream = await fetch(`${OPENCODE_BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "unknown");
    return res.status(upstream.status).json({
      error: { message: `Upstream error: ${upstream.status} ${errText}` },
    });
  }

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (e) {}
    return res.end();
  }

  // Non-stream: buffer SSE and convert to JSON
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } catch (e) {}

  const lines = buffer.split("\n");
  let content = "";
  let reasoningContent = "";
  let lastParsed = null;
  let usage = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") break;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) {
          usage = parsed.usage;
        }
        if (parsed.choices && parsed.choices.length > 0) {
          lastParsed = parsed;
          const delta = parsed.choices[0].delta || {};
          if (delta.content) {
            content += delta.content;
          }
          if (delta.reasoning_content) {
            reasoningContent += delta.reasoning_content;
          }
        }
      } catch (e) {}
    }
  }

  if (lastParsed) {
    const message = {
      role: "assistant",
      content,
    };
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }
    return res.status(200).json({
      id: lastParsed.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: lastParsed.created || Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: "stop",
        },
      ],
      usage: usage || lastParsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  return res.status(502).json({ error: { message: "Failed to parse SSE response" } });
}

// ── Forward to /responses (Muse Spark & Responses-only Models) ──

async function forwardResponses(req, res, body, model, sessionId, requestId, stream) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer public",
    "x-opencode-client": "desktop",
    "x-opencode-session": sessionId,
    "x-opencode-request": requestId,
    "x-opencode-project": "global",
    "Accept": "text/event-stream",
    "User-Agent": OPENCODE_UA,
  };

  const messages = body.messages || [];
  const systemParts = [];
  const input = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p) => p.text || "").join("") : "");
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p) => p.text || "").join("") : "");
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text || " " }],
      });
    } else if (m.role === "assistant") {
      if (m.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
        });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id || `call_${Date.now()}`,
            name: tc.function?.name || "",
            arguments: typeof tc.function?.arguments === "object" ? JSON.stringify(tc.function.arguments) : (tc.function?.arguments || "{}"),
          });
        }
      }
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "",
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content || {}),
      });
    }
  }

  if (!input.length) {
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "..." }],
    });
  }

  // Build tools array with fingerprint tools + custom tools
  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      const fn = t.function || t;
      if (fn.name) {
        tools.push({
          type: "function",
          name: fn.name,
          description: fn.description || `${fn.name} tool`,
          parameters: fn.parameters || { type: "object", properties: {} },
        });
      }
    }
  }
  const existingNames = new Set(tools.map((t) => t.name.toLowerCase()));
  for (const name of FINGERPRINT_TOOLS) {
    if (!existingNames.has(name)) {
      tools.push({
        type: "function",
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {} },
      });
    }
  }

  const payload = {
    model,
    input,
    stream: true,
    store: false,
    max_output_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    tools,
  };
  if (tools.length) {
    payload.tool_choice = "auto";
  }
  if (systemParts.length) {
    payload.instructions = systemParts.join("\n\n");
  }

  const upstream = await fetch(`${OPENCODE_BASE}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "unknown");
    return res.status(upstream.status).json({
      error: { message: `Upstream error: ${upstream.status} ${errText}` },
    });
  }

  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const createdTime = Math.floor(Date.now() / 1000);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let usageData = null;
    const respToolIndex = new Map();
    let toolCallCount = 0;
    const toolArgsTrack = [];
    let hasToolCalls = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const dataStr = trimmed.slice(6).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const ev = JSON.parse(dataStr);

            // Text delta
            if (ev.type === "response.output_text.delta" && ev.delta) {
              const chunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created: createdTime,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: ev.delta },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            // Function call started
            if (ev.type === "response.output_item.added" && (ev.item?.type === "function_call" || ev.item?.type === "custom_tool_call")) {
              hasToolCalls = true;
              const item = ev.item;
              const callId = item.call_id || item.id || `call_${crypto.randomBytes(8).toString("hex")}`;
              const key = item.id || ev.item_id || callId;
              let idx = respToolIndex.get(key);
              if (idx === undefined) {
                idx = toolCallCount++;
                respToolIndex.set(key, idx);
                toolArgsTrack[idx] = { id: callId, name: item.name || "", args: "" };
              }
              const chunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created: createdTime,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: idx,
                          id: callId,
                          type: "function",
                          function: {
                            name: item.name || "",
                            arguments: "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            // Function call arguments delta
            if ((ev.type === "response.function_call_arguments.delta" || ev.type === "response.custom_tool_call_input.delta") && ev.delta) {
              hasToolCalls = true;
              const key = ev.item_id;
              const idx = (key && respToolIndex.has(key)) ? respToolIndex.get(key) : Math.max(0, toolCallCount - 1);
              if (toolArgsTrack[idx]) {
                toolArgsTrack[idx].args += ev.delta;
              }
              const chunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created: createdTime,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: idx,
                          function: {
                            arguments: ev.delta,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            // Function call done (in case full arguments emitted only here)
            if (ev.type === "response.output_item.done" && (ev.item?.type === "function_call" || ev.item?.type === "custom_tool_call")) {
              const key = ev.item?.id || ev.item_id;
              const idx = (key && respToolIndex.has(key)) ? respToolIndex.get(key) : Math.max(0, toolCallCount - 1);
              const fullArgs = ev.item?.arguments;
              if (fullArgs && toolArgsTrack[idx] && !toolArgsTrack[idx].args) {
                toolArgsTrack[idx].args = fullArgs;
                const chunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: createdTime,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: idx,
                            function: {
                              arguments: fullArgs,
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            }

            // Usage
            if (ev.type === "response.completed" && ev.response?.usage) {
              usageData = {
                prompt_tokens: ev.response.usage.input_tokens || 0,
                completion_tokens: ev.response.usage.output_tokens || 0,
                total_tokens: ev.response.usage.total_tokens || 0,
              };
            }
          } catch (e) {}
        }
      }

      const endChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTime,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: usageData,
      };
      res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
    } catch (e) {}
    return res.end();
  }

  // Non-stream: buffer text deltas & tool calls
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let fullText = "";
  let usageData = null;
  const nonStreamToolMap = new Map();
  const nonStreamTools = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const ev = JSON.parse(dataStr);
          if (ev.type === "response.output_text.delta" && ev.delta) {
            fullText += ev.delta;
          }
          if (ev.type === "response.output_item.added" && (ev.item?.type === "function_call" || ev.item?.type === "custom_tool_call")) {
            const item = ev.item;
            const callId = item.call_id || item.id || `call_${crypto.randomBytes(8).toString("hex")}`;
            const key = item.id || ev.item_id || callId;
            const tc = {
              id: callId,
              type: "function",
              function: {
                name: item.name || "",
                arguments: item.arguments || "",
              },
            };
            nonStreamToolMap.set(key, tc);
            nonStreamTools.push(tc);
          }
          if ((ev.type === "response.function_call_arguments.delta" || ev.type === "response.custom_tool_call_input.delta") && ev.delta) {
            const tc = ev.item_id ? nonStreamToolMap.get(ev.item_id) : nonStreamTools[nonStreamTools.length - 1];
            if (tc) {
              tc.function.arguments += ev.delta;
            }
          }
          if (ev.type === "response.output_item.done" && (ev.item?.type === "function_call" || ev.item?.type === "custom_tool_call")) {
            const key = ev.item?.id || ev.item_id;
            const tc = key ? nonStreamToolMap.get(key) : nonStreamTools[nonStreamTools.length - 1];
            if (tc && ev.item?.arguments && !tc.function.arguments) {
              tc.function.arguments = ev.item.arguments;
            }
          }
          if (ev.type === "response.completed" && ev.response?.usage) {
            usageData = {
              prompt_tokens: ev.response.usage.input_tokens || 0,
              completion_tokens: ev.response.usage.output_tokens || 0,
              total_tokens: ev.response.usage.total_tokens || 0,
            };
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  const message = {
    role: "assistant",
    content: fullText || (nonStreamTools.length ? null : ""),
  };
  if (nonStreamTools.length > 0) {
    message.tool_calls = nonStreamTools;
  }

  return res.status(200).json({
    id: completionId,
    object: "chat.completion",
    created: createdTime,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: nonStreamTools.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: usageData || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
