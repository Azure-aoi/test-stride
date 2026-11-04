import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import dns from "node:dns/promises";
import net from "node:net";

const PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL_MAX_TOKENS = Number(
  process.env.MODEL_MAX_OUTPUT_TOKENS || 4096
);

export function normalizeModelConfig(input = {}) {
  const provider = String(input.provider || "local");
  return {
    provider,
    apiStyle: String(input.apiStyle || (provider === "anthropic" ? "messages" : "chat-completions")),
    baseUrl: String(input.baseUrl || "").trim(),
    model: String(input.model || "").trim(),
    fallbackModel: String(input.fallbackModel || "").trim(),
    planningModel: String(input.planningModel || "").trim(),
    apiKey: String(input.apiKey || "").trim(),
    label: String(input.label || input.model || provider).trim()
  };
}

export function validateModelConfig(config) {
  if (config.provider === "local") return;
  if (!config.apiKey) throw apiError("MISSING_API_KEY", "请填写模型 API Key");
  if (!config.model) throw apiError("MISSING_MODEL", "请填写模型名称");
  if (config.apiStyle !== "responses" && !config.baseUrl) {
    throw apiError("MISSING_BASE_URL", "请填写模型 Base URL");
  }
  if (config.baseUrl) {
    let url;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw apiError("INVALID_BASE_URL", "Base URL 格式不正确");
    }
    if (!["https:", "http:"].includes(url.protocol)) {
      throw apiError("INVALID_BASE_URL", "Base URL 仅支持 HTTP 或 HTTPS");
    }
  }
}

function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function endpointError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  error.expose = true;
  return error;
}

function blockedIp(address) {
  if (!address) return false;
  const value = String(address).toLowerCase();
  if (value === "169.254.169.254" || value === "100.100.100.200") return true;
  if (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return false;
}

function hostnameAllowed(hostname) {
  const allowlist = String(process.env.MODEL_BASE_URL_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!allowlist.length) return true;
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.includes("://")
      ? new URL(entry).hostname.toLowerCase()
      : entry;
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export async function validateModelBaseUrlSafety(config) {
  if (!config.baseUrl) return;
  const url = new URL(config.baseUrl);
  if (!hostnameAllowed(url.hostname)) {
    throw endpointError(
      "MODEL_BASE_URL_BLOCKED",
      "模型 Base URL 不在允许的域名列表中"
    );
  }
  const blockPrivate =
    String(process.env.BLOCK_PRIVATE_MODEL_URLS || "").toLowerCase() === "true";
  if (!blockPrivate && url.hostname !== "169.254.169.254") return;
  if (url.hostname === "localhost" || blockedIp(url.hostname)) {
    throw endpointError(
      "MODEL_BASE_URL_BLOCKED",
      "模型 Base URL 指向本机、内网或云元数据地址"
    );
  }
  try {
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (addresses.some((item) => blockedIp(item.address))) {
      throw endpointError(
        "MODEL_BASE_URL_BLOCKED",
        "模型 Base URL 解析到本机、内网或云元数据地址"
      );
    }
  } catch (error) {
    if (error.code === "MODEL_BASE_URL_BLOCKED") throw error;
    throw endpointError("MODEL_DNS_FAILED", "无法解析模型服务域名");
  }
}

function providerError(error) {
  if (error.code && error.status === 400) return error;
  if (
    error.code === "MODEL_EMPTY_RESPONSE" ||
    error.code === "MODEL_OUTPUT_TRUNCATED"
  ) {
    return error;
  }
  const status = error.status || error.statusCode || 502;
  const errorText = `${error.message || ""} ${error.cause?.code || ""}`;
  const networkFailure =
    !error.status &&
    /connection|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(
      errorText
    );
  const code =
    networkFailure
      ? "MODEL_NETWORK_ERROR"
      : status === 401 || status === 403
      ? "MODEL_AUTH_FAILED"
      : status === 404
        ? "MODEL_NOT_FOUND"
        : status === 429
          ? "MODEL_RATE_LIMITED"
          : "MODEL_REQUEST_FAILED";
  const message =
    code === "MODEL_NETWORK_ERROR"
      ? "无法连接模型服务，请检查网络、代理或 Base URL"
      : code === "MODEL_AUTH_FAILED"
      ? "模型认证失败，请检查 API Key"
      : code === "MODEL_NOT_FOUND"
        ? "模型或接口地址不存在，请检查配置"
        : code === "MODEL_RATE_LIMITED"
          ? "模型请求过于频繁或额度不足"
          : "模型请求失败，请检查接口配置或稍后重试";
  const wrapped = new Error(message);
  wrapped.code = code;
  wrapped.status = status >= 400 && status < 600 ? status : 502;
  wrapped.expose = true;
  wrapped.providerMessage = errorText;
  return wrapped;
}

function openAIClient(config) {
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl.replace(/\/$/, "") } : {}),
    timeout: PROVIDER_TIMEOUT_MS
  });
}

function anthropicClient(config) {
  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl.replace(/\/$/, "") } : {}),
    timeout: PROVIDER_TIMEOUT_MS
  });
}

function extractResponsesText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractAnthropicText(response) {
  return (response.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function messageForResponses(messages) {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `${role}: ${message.content}`;
    })
    .join("\n\n");
}

function normalizedMessages(messages) {
  return (messages || [])
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "")
    }));
}

function emptyResponseError() {
  const error = new Error("模型返回了空文本");
  error.code = "MODEL_EMPTY_RESPONSE";
  error.status = 502;
  error.expose = true;
  return error;
}

function truncatedOutputError() {
  const error = new Error("模型输出达到长度上限，回答可能不完整");
  error.code = "MODEL_OUTPUT_TRUNCATED";
  error.status = 502;
  error.expose = true;
  return error;
}

async function requestModelOnce(
  config,
  system,
  messages,
  { test = false, signal = null, maxTokens = DEFAULT_MODEL_MAX_TOKENS } = {}
) {
  validateModelConfig(config);
  try {
    if (config.apiStyle === "responses") {
      const client = openAIClient(config);
      const response = await client.responses.create({
        model: config.model,
        instructions: system,
        input: messageForResponses(messages),
        max_output_tokens: test ? 24 : maxTokens
      }, signal ? { signal } : undefined);
      if (
        response.status === "incomplete" ||
        response.incomplete_details?.reason === "max_output_tokens"
      ) {
        throw truncatedOutputError();
      }
      const text = extractResponsesText(response);
      if (text) return text;
      if (test) return "OK";
      throw emptyResponseError();
    }

    const conversation = normalizedMessages(messages);
    if (config.apiStyle === "messages") {
      const client = anthropicClient(config);
      const response = await client.messages.create({
        model: config.model,
        max_tokens: test ? 24 : maxTokens,
        system,
        messages: conversation
      }, signal ? { signal } : undefined);
      if (response.stop_reason === "max_tokens") throw truncatedOutputError();
      const text = extractAnthropicText(response);
      if (text) return text;
      if (test) return "OK";
      throw emptyResponseError();
    }

    const client = openAIClient(config);
    const response = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: system },
        ...conversation
      ],
      max_tokens: test ? 24 : maxTokens
    }, signal ? { signal } : undefined);
    const choice = response.choices?.[0];
    if (choice?.finish_reason === "length") throw truncatedOutputError();
    const text = choice?.message?.content?.trim();
    if (text) return text;
    if (test) return "OK";
    throw emptyResponseError();
  } catch (error) {
    if (error?.name === "AbortError") {
      const cancelled = new Error("Agent 运行已取消");
      cancelled.code = "RUN_CANCELLED";
      cancelled.status = 499;
      throw cancelled;
    }
    throw providerError(error);
  }
}

function isRetryableModelError(error) {
  if (error?.code === "MODEL_OUTPUT_TRUNCATED") return false;
  const status = Number(error?.status || 0);
  return status === 429 || status >= 500 || error?.code === "MODEL_REQUEST_FAILED";
}

function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function toChatMessages(messages) {
  return messages.map((message) => {
    if (message.role === "assistant_native") {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: String(message.content ?? "")
      };
    }
    return { role: message.role, content: String(message.content ?? "") };
  });
}

function toAnthropicMessages(messages) {
  return messages.map((message) => {
    if (message.role === "assistant_native") {
      return { role: "assistant", content: message.contentBlocks };
    }
    if (message.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: String(message.content ?? "")
          }
        ]
      };
    }
    return { role: message.role, content: String(message.content ?? "") };
  });
}

function toResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "assistant_native") {
      input.push(...(message.output || []));
    } else if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: String(message.content ?? "")
      });
    } else {
      input.push({ role: message.role, content: String(message.content ?? "") });
    }
  }
  return input;
}

function toolsUnsupportedError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const text = `${error?.message || ""} ${error?.error?.message || ""}`;
  if (![400, 422].includes(status)) return null;
  if (!/tool|function|unsupported|not support|不支持/i.test(text)) return null;
  const unsupported = new Error(
    "当前模型接口不支持原生工具调用，已切换到 JSON 工具协议"
  );
  unsupported.code = "MODEL_TOOLS_UNSUPPORTED";
  unsupported.status = 400;
  unsupported.expose = true;
  return unsupported;
}

async function requestNativeDecisionOnce(
  config,
  system,
  messages,
  tools,
  signal = null
) {
  validateModelConfig(config);
  try {
    if (config.apiStyle === "responses") {
      const client = openAIClient(config);
      const response = await client.responses.create(
        {
          model: config.model,
          instructions: system,
          input: toResponsesInput(messages),
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          })),
          tool_choice: "auto",
          max_output_tokens: DEFAULT_MODEL_MAX_TOKENS
        },
        signal ? { signal } : undefined
      );
      if (
        response.status === "incomplete" ||
        response.incomplete_details?.reason === "max_output_tokens"
      ) {
        throw truncatedOutputError();
      }
      const output = response.output || [];
      const calls = output.filter((item) => item.type === "function_call");
      const content = extractResponsesText(response);
      if (calls.length) {
        return {
          content,
          toolCalls: calls.map((item) => ({
            id: item.call_id,
            name: item.name,
            arguments: parseToolArguments(item.arguments)
          })),
          assistantMessage: { role: "assistant_native", output }
        };
      }
      if (content) return { content, toolCalls: [], assistantMessage: null };
      throw emptyResponseError();
    }

    if (config.apiStyle === "messages") {
      const client = anthropicClient(config);
      const response = await client.messages.create(
        {
          model: config.model,
          max_tokens: DEFAULT_MODEL_MAX_TOKENS,
          system,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
          })),
          tool_choice: { type: "auto" },
          messages: toAnthropicMessages(messages)
        },
        signal ? { signal } : undefined
      );
      if (response.stop_reason === "max_tokens") throw truncatedOutputError();
      const blocks = response.content || [];
      const calls = blocks.filter((block) => block.type === "tool_use");
      const content = extractAnthropicText(response);
      if (calls.length) {
        return {
          content,
          toolCalls: calls.map((block) => ({
            id: block.id,
            name: block.name,
            arguments: parseToolArguments(block.input)
          })),
          assistantMessage: {
            role: "assistant_native",
            contentBlocks: blocks
          }
        };
      }
      if (content) return { content, toolCalls: [], assistantMessage: null };
      throw emptyResponseError();
    }

    const client = openAIClient(config);
    const response = await client.chat.completions.create(
      {
        model: config.model,
        messages: [
          { role: "system", content: system },
          ...toChatMessages(messages)
        ],
        max_tokens: DEFAULT_MODEL_MAX_TOKENS,
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: "auto"
      },
      signal ? { signal } : undefined
    );
    const choice = response.choices?.[0];
    if (choice?.finish_reason === "length") throw truncatedOutputError();
    const message = choice?.message;
    const calls = message?.tool_calls || [];
    if (calls.length) {
      return {
        content: message.content || "",
        toolCalls: calls.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: parseToolArguments(call.function?.arguments)
        })),
        assistantMessage: {
          role: "assistant_native",
          content: message.content || "",
          toolCalls: calls
        }
      };
    }
    const text = message?.content?.trim();
    if (text) return { content: text, toolCalls: [], assistantMessage: null };
    throw emptyResponseError();
  } catch (error) {
    if (error?.name === "AbortError") {
      const cancelled = new Error("Agent 运行已取消");
      cancelled.code = "RUN_CANCELLED";
      cancelled.status = 499;
      throw cancelled;
    }
    if (
      [
        "MODEL_EMPTY_RESPONSE",
        "MODEL_OUTPUT_TRUNCATED",
        "RUN_CANCELLED"
      ].includes(error?.code)
    ) {
      throw error;
    }
    const unsupported = toolsUnsupportedError(error);
    if (unsupported) throw unsupported;
    throw providerError(error);
  }
}

export async function generateNativeAgentDecision({
  config,
  system,
  messages,
  tools = [],
  signal = null
}) {
  await validateModelBaseUrlSafety(config);
  return withModelRetry(config, async (activeConfig, attempts) => {
    const decision = await requestNativeDecisionOnce(
      activeConfig,
      system,
      messages,
      tools,
      signal
    );
    return {
      ...decision,
      model: activeConfig.model,
      fallback: activeConfig.model !== config.model,
      attempts
    };
  });
}

async function withModelRetry(config, request) {
  const attempts = [];
  let activeConfig = config;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request(activeConfig, attempts);
    } catch (error) {
      attempts.push({
        model: activeConfig.model,
        code: error.code || "MODEL_REQUEST_FAILED",
        message: error.message
      });
      if (error.code === "RUN_CANCELLED" || !isRetryableModelError(error)) throw error;
      if (attempt === 1 && config.fallbackModel && activeConfig.model === config.model) {
        activeConfig = { ...config, model: config.fallbackModel };
      } else if (attempt >= 2) {
        throw error;
      }
    }
  }
  throw new Error("模型调用失败");
}

async function runModelConversation(
  config,
  system,
  messages,
  options = {}
) {
  await validateModelBaseUrlSafety(config);
  return withModelRetry(config, async (activeConfig, attempts) => {
    const content = await requestModelOnce(activeConfig, system, messages, options);
    return {
      content,
      model: activeConfig.model,
      fallback: activeConfig.model !== config.model,
      attempts
    };
  });
}

async function runModel(config, system, userPrompt, { test = false, signal = null } = {}) {
  const result = await runModelConversation(
    config,
    system,
    [{ role: "user", content: userPrompt }],
    { test, signal }
  );
  return result.content;
}

export async function testModelConnection(config) {
  if (config.provider === "local") {
    return { ok: true, message: "本地分析模式可用" };
  }
  await runModel(
    config,
    "你是模型连通性测试助手。",
    "请只回复：连接成功",
    { test: true }
  );
  return { ok: true, message: "连接成功" };
}

export async function generateAgentDecision({
  config,
  system,
  messages,
  signal = null
}) {
  return runModelConversation(config, system, messages, {
    signal,
    maxTokens: DEFAULT_MODEL_MAX_TOKENS
  });
}

export async function extractAgentMemories({
  config,
  question,
  answer,
  signal = null
}) {
  const system = [
    "你是长期记忆提取器，只负责从用户原话中提取未来仍然有效的个人事实。",
    "允许的类型：goal（目标比赛或成绩）、preference（训练时间、场地、课程偏好或明确拒绝）、injury（伤病或身体限制）、decision（用户确认的长期决定）、profile（年龄、水平、稳定可训练时间等）。",
    "禁止提取：本轮训练数据、模型建议、临时情绪、猜测、医疗诊断，以及用户没有明确说出的内容。",
    "助手回答只用于消除指代歧义，不得作为事实来源。",
    "没有可提取内容时返回空数组 []。",
    "最多提取 3 条，使用第三人称短句，不要重复已有记忆。",
    '只输出 JSON 数组，每项格式为 {"type":"preference","content":"...","importance":0.8}。'
  ].join("\n");
  const prompt = [
    `用户本轮原话：${String(question || "").slice(0, 2000)}`,
    `助手回答（仅用于消歧）：${String(answer || "").slice(0, 1500)}`
  ].join("\n\n");
  const result = await runModelConversation(
    config,
    system,
    [{ role: "user", content: prompt }],
    { signal, maxTokens: 400 }
  );
  return result.content;
}

export async function reflectAgentAnswer({
  config,
  system,
  question,
  answer,
  observations,
  signal = null
}) {
  const reflectionPrompt = [
    "请审查下面这份训练回答，只做事实和约束检查。",
    `用户问题：${question}`,
    `工具观察：${JSON.stringify(observations, null, 2)}`,
    `初稿：${answer}`,
    "检查数值是否来自工具观察、是否违反伤病限制、是否把计划预览说成已写入。",
    "如果无需修改，原样返回初稿；如果需要修改，返回修订后的完整中文回答，不要解释审查过程。"
  ].join("\n\n");
  const result = await runModelConversation(
    config,
    system,
    [{ role: "user", content: reflectionPrompt }],
    { signal, maxTokens: DEFAULT_MODEL_MAX_TOKENS }
  );
  return result.content;
}
