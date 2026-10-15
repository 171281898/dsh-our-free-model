/**
 * OpenAI chat payload 构造 + FreeTier 形状门禁注入。
 *
 * ## 门禁依据（设计文档 §0.6，opencode2dsh 2026-09-18 实测）
 *
 * 匿名通道拒绝**不带 agent 形状**的 body，回 403 FreeTierError。当前门禁
 * 要求 `stream: true`，并且 `tools` 中包含 `bash`、`glob`、`grep`、`read`
 * 四个 function 工具；`bash` 与 `read` 的参数 schema 还必须至少声明一个
 * property。桌面端必须和插件端保持同一套线协议。
 *
 * ⚠️ 门禁参数**收敛在本文件**，不散落到适配器 —— 服务端再收紧时只改一处。
 * ⚠️ 账号槽（带 API key）**同样注入**：免费通道与认证通道的服务端策略
 * 可能共用同一层形状检查，多注入一层对认证通道无害（官方 CLI 本来也带
 * 全套工具），但缺了它就可能让匿名槽整体失效。
 */

/** DSH 的工具 schema（`GenerateOptions.tools` 的形状）。 */
export interface OpencodeHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** OpenAI wire 侧的工具定义。 */
export interface OpencodeWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/** 门禁工具名（服务端按这四个名字识别官方客户端形状）。 */
export const FREE_LANE_GATE_TOOLS = ['bash', 'glob', 'grep', 'read'] as const
const FREE_LANE_GATE_TOOL_SET = new Set<string>(FREE_LANE_GATE_TOOLS)

/** wire 名称 → 调用方名称；响应工具调用时需要还原调用方名称。 */
export type OpencodeToolNameMap = ReadonlyMap<string, string>

/** 门禁桩工具：描述固定为「不要调用」，参数为空对象。 */
const FINGERPRINT_PROPERTY = {
  type: 'string',
  description: 'This tool is currently unavailable and must not be used.',
}

function gateTool(name: string): OpencodeWireTool {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: { input: FINGERPRINT_PROPERTY } },
    },
  }
}

function canonicalGateToolName(name: string): string {
  const lower = name.toLowerCase()
  return FREE_LANE_GATE_TOOL_SET.has(lower) ? lower : name
}

function canonicalizeWireTools(
  tools: readonly unknown[],
  toolNameMap?: Map<string, string>,
): unknown[] {
  const seen = new Set<string>()
  const next: unknown[] = []
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) {
      next.push(tool)
      continue
    }
    const row = tool as { function?: { name?: unknown } }
    const name = row.function?.name
    if (typeof name !== 'string') {
      next.push(tool)
      continue
    }
    const canonical = canonicalGateToolName(name)
    const isGateTool = FREE_LANE_GATE_TOOL_SET.has(canonical)
    if (isGateTool) {
      if (seen.has(canonical)) continue
      seen.add(canonical)
    }
    if (toolNameMap !== undefined && canonical !== name) toolNameMap.set(canonical, name)
    if (canonical === name) {
      next.push(tool)
      continue
    }
    next.push({
      ...row,
      function: { ...row.function, name: canonical },
    })
  }
  return next
}

/**
 * DSH 工具 → wire 工具。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。不下发它，模型在 wire 上看不到
 * 任何函数定义，只能用正文里的 XML 臆造工具调用 —— qoder 的用户报障
 * 「执行任务出现任务调用 xml 泄露任务终止」就是这个根因。
 */
export function buildOpencodeTools(
  tools: readonly OpencodeHarnessTool[] | undefined,
  toolNameMap?: Map<string, string>,
): OpencodeWireTool[] {
  if (tools === undefined || tools.length === 0) return []
  const wireTools = tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
  return canonicalizeWireTools(wireTools, toolNameMap) as OpencodeWireTool[]
}

/**
 * 注入门禁工具，必要时补 `tool_choice`。
 *
 * ⚠️ `tool_choice: 'none'` **只在原本一个工具都没有时**补：真实工具在列时
 * 覆盖用户的自选 tool_choice 会改变模型行为（模型将无法调用任何工具，
 * 而 harness 仍在等它调用 —— 表现为工具执行不推进）。
 *
 * @returns 满足门禁的 body；已满足或非 chat body 时**返回同一引用**。
 */
export function ensureFreeLaneShape(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.messages)) return payload
  const tools = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : []
  const canonicalTools = canonicalizeWireTools(tools)
  const next = canonicalTools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) return tool
    const row = tool as { function?: { name?: unknown; parameters?: unknown } }
    const name = row.function?.name
    if (name !== 'bash' && name !== 'read') return tool
    const schema = row.function?.parameters
    const properties = schema !== null && typeof schema === 'object'
      ? (schema as { properties?: unknown }).properties
      : undefined
    if (properties !== null && typeof properties === 'object' && Object.keys(properties as object).length > 0) return tool
    return {
      ...row,
      function: {
        ...row.function,
        parameters: {
          ...(schema !== null && typeof schema === 'object' ? schema : {}),
          type: 'object',
          properties: { input: FINGERPRINT_PROPERTY },
        },
      },
    }
  })
  const present = new Set<string>()
  for (const tool of next) {
    if (typeof tool !== 'object' || tool === null) continue
    const name = (tool as { function?: { name?: unknown } }).function?.name
    if (typeof name === 'string') present.add(name.toLowerCase())
  }
  const missing = FREE_LANE_GATE_TOOLS.filter((name) => !present.has(name))
  if (missing.length === 0 && next.length === tools.length && next.every((tool, index) => tool === tools[index])) return payload
  return {
    ...payload,
    tools: [...next, ...missing.map(gateTool)],
    ...(tools.length === 0 ? { tool_choice: 'none' } : {}),
  }
}

export interface OpencodePayloadInput {
  model: string
  messages: ReadonlyArray<Record<string, unknown>>
  system?: string
  tools?: readonly OpencodeHarnessTool[]
  temperature?: number
  maxTokens?: number
  /**
   * 思考档位（issue IKJJ0V）。
   *
   * ⚠️ 取自 `GenerateOptions.reasoningEffort`（品牌类型 `ReasoningEffortId`，
   * 传进来前转成普通字符串）。声明了档位就**必须真的发出去**，否则选择器只是
   * UI 装饰 —— 用户选了「高」却没有任何效果。
   */
  reasoningEffort?: string
}

/** 构造一次 chat 请求的完整 body（已过门禁）。 */
export function buildOpencodePayloadWithToolMap(input: OpencodePayloadInput): {
  payload: Record<string, unknown>
  toolNameMap: OpencodeToolNameMap
} {
  const toolNameMap = new Map<string, string>()
  const base: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    // ⚠️ 恒 true：这是门禁的一半要求。
    stream: true,
    tools: buildOpencodeTools(input.tools, toolNameMap),
    ...input.system !== undefined && input.system.length > 0 ? { system: input.system } : {},
    ...typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {},
    // ⚠️ 只放行安全正整数：0 / 负数 / NaN 会让 DSH 侧抛
    // INVALID_MODEL_MAX_TOKENS，把整轮对话搞崩（不是降级，是崩）。
    ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
      ? { max_tokens: input.maxTokens }
      : {},
    // ⚠️ 思考档位（issue IKJJ0V）。**声明了档位就必须真的发出去**，
    // 否则选择器只是 UI 装饰 —— 用户选了「高」却拿不到任何效果。
    //
    // 参数名 `reasoning_effort` 由**实测**确定（2026-10-02）：给
    // `ling-3.0-flash-fin-free` 传非法值时，错误信息变成 `[400] reasoning_…`
    // （与基线的 `Endpoint is unavailable` 不同），说明 Zen 侧确实解析并校验它。
    //
    // ⚠️ `none`（关闭思考）照发：models.dev 的 `toggle` 形态就产出这一档，
    // 上游靠它区分「关」与「最低档开」。
    ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
      ? { reasoning_effort: input.reasoningEffort }
      : {},
  }
  return { payload: ensureFreeLaneShape(base), toolNameMap }
}

/** 构造一次 chat 请求的完整 body（已过门禁）。 */
export function buildOpencodePayload(input: OpencodePayloadInput): Record<string, unknown> {
  return buildOpencodePayloadWithToolMap(input).payload
}
