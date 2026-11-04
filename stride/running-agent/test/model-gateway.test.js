import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  generateAgentDecision,
  generateNativeAgentDecision
} from "../src/model-gateway.js";

const tools = [
  {
    name: "getTrainingMetrics",
    description: "读取训练指标",
    parameters: {
      type: "object",
      properties: { days: { type: "integer" } },
      additionalProperties: false
    }
  },
  {
    name: "getRunnerProfile",
    description: "读取跑者档案",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }
];

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startMockModel(responses) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(await readBody(request));
    const body = responses[requests.length - 1];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function configFor(baseUrl, overrides = {}) {
  return {
    provider: "openai-compatible",
    apiStyle: "chat-completions",
    baseUrl,
    model: "test-model",
    fallbackModel: "",
    apiKey: "test",
    label: "测试",
    ...overrides
  };
}

test("detects provider output truncated by token limit", async () => {
  const server = await startMockModel([
    {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "这是一个被截断的回答" },
          finish_reason: "length"
        }
      ]
    }
  ]);
  try {
    await assert.rejects(
      generateAgentDecision({
        config: configFor(server.baseUrl),
        system: "test",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error.code === "MODEL_OUTPUT_TRUNCATED"
    );
  } finally {
    await server.close();
  }
});

test("chat completions native tool calls round-trip through tool messages", async () => {
  const server = await startMockModel([
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "getTrainingMetrics",
                  arguments: '{"days":28}'
                }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    },
    {
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "已完成分析" },
          finish_reason: "stop"
        }
      ]
    }
  ]);
  try {
    const config = configFor(server.baseUrl);
    const messages = [{ role: "user", content: "分析一下" }];
    const first = await generateNativeAgentDecision({
      config,
      system: "系统提示",
      messages,
      tools
    });
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0].name, "getTrainingMetrics");
    assert.deepEqual(first.toolCalls[0].arguments, { days: 28 });
    assert.equal(server.requests[0].tools[0].function.name, "getTrainingMetrics");

    messages.push(first.assistantMessage);
    messages.push({
      role: "tool",
      toolCallId: "call_1",
      name: "getTrainingMetrics",
      content: "指标结果"
    });
    const second = await generateNativeAgentDecision({
      config,
      system: "系统提示",
      messages,
      tools
    });
    assert.equal(second.content, "已完成分析");
    assert.equal(second.toolCalls.length, 0);
    assert.equal(server.requests[1].messages.at(-1).role, "tool");
    assert.equal(server.requests[1].messages.at(-1).tool_call_id, "call_1");
  } finally {
    await server.close();
  }
});

test("anthropic native tool calls replay tool_result blocks", async () => {
  const server = await startMockModel([
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [
        { type: "text", text: "先读取档案" },
        { type: "tool_use", id: "toolu_1", name: "getRunnerProfile", input: {} }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    },
    {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "档案已读取" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  ]);
  try {
    const config = configFor(server.baseUrl, {
      provider: "anthropic",
      apiStyle: "messages"
    });
    const messages = [{ role: "user", content: "我的目标是什么" }];
    const first = await generateNativeAgentDecision({
      config,
      system: "系统提示",
      messages,
      tools
    });
    assert.equal(first.toolCalls[0].name, "getRunnerProfile");
    assert.deepEqual(first.toolCalls[0].arguments, {});

    messages.push(first.assistantMessage);
    messages.push({
      role: "tool",
      toolCallId: "toolu_1",
      name: "getRunnerProfile",
      content: "档案结果"
    });
    const second = await generateNativeAgentDecision({
      config,
      system: "系统提示",
      messages,
      tools
    });
    assert.equal(second.content, "档案已读取");
    const toolMessage = server.requests[1].messages.at(-1);
    assert.equal(toolMessage.role, "user");
    assert.equal(toolMessage.content[0].type, "tool_result");
    assert.equal(toolMessage.content[0].tool_use_id, "toolu_1");
  } finally {
    await server.close();
  }
});

test("responses native tool calls replay function_call_output input", async () => {
  const server = await startMockModel([
    {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "getRunnerProfile",
          arguments: "{}"
        }
      ],
      output_text: ""
    },
    {
      id: "resp_2",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "读取完成" }]
        }
      ],
      output_text: "读取完成"
    }
  ]);
  try {
    const config = configFor(server.baseUrl, {
      provider: "openai",
      apiStyle: "responses"
    });
    const messages = [{ role: "user", content: "读取档案" }];
    const first = await generateNativeAgentDecision({
      config,
      system: "系统提示",
      messages,
      tools
    });
    assert.equal(first.toolCalls[0].name, "getRunnerProfile");
    assert.equal(server.requests[0].tools[0].type, "function");

    messages.push(first.assistantMessage);
    messages.push({
      role: "tool",
      toolCallId: "call_1",
      name: "getRunnerProfile",
      content: "档案结果"
    });
    const second = await generateNativeAgentDecision({
      config,
      system: "系统提示",
      messages,
      tools
    });
    assert.equal(second.content, "读取完成");
    const input = server.requests[1].input;
    assert.ok(input.some((item) => item.type === "function_call"));
    assert.ok(
      input.some(
        (item) =>
          item.type === "function_call_output" && item.call_id === "call_1"
      )
    );
  } finally {
    await server.close();
  }
});
