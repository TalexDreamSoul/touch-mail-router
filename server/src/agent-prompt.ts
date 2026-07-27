export type DomainAutomationPromptInput = {
  baseUrl: string;
  domainId: string;
  domain: string;
  channelType: "worker" | "email_forward" | "donemail" | "api_push";
  channelName: string;
  collectorType?: "webhook" | "donemail" | "";
  scope: "all" | "specific";
  address?: string;
  workerName?: string;
  forwardingTarget?: string;
};

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export function buildGeneralAutomationPrompt(baseUrl: string): string {
  const base = normalizedBaseUrl(baseUrl);
  return `你是 Touch Mail 的域名接入执行代理。你的任务是使用用户已经授权的 Cloudflare MCP、Cloudflare API 或 CLI，完成 DNS、Email Routing、Worker 部署和路由规则配置，并给出可验证的结果。

操作原则：
1. 先读取 ${base}/ai/v1/openapi.json、${base}/ai/v1/skill 和目标域名的 setup-guide。setup-guide 返回的域名、Worker Name、变量、Secret 状态和规则字段是唯一可信输入，不要猜测。
2. 先探测现有能力和权限：确认 Cloudflare 账户、Zone、当前 DNS、Email Routing 状态、Workers 和 Rules。优先使用已连接的 Cloudflare MCP/API；有 Node.js 时可运行 npx wrangler whoami 和 npx wrangler deploy，不要求全局安装，不使用 sudo 或 root。没有可用工具或授权时停止并请求用户完成登录，不要索取或回显明文 API Token。
3. 修改前保存现状快照，列出将新增、修改或删除的资源。删除规则、替换 Worker、修改 MX、覆盖已有 DNS 或扩大 Catch-all 范围前，必须获得用户明确确认。
4. DNS 与 Email Routing：确认 Zone 已激活且名称服务器正确。使用 Cloudflare 当前 MCP/API 暴露的 Email Routing 启用和 DNS 配置能力，让 Cloudflare 生成或校验所需 MX/TXT；不要凭记忆手写或猜测 MX。保留无关 DNS 记录；发现已有 MX 冲突时停止并解释影响。
5. Worker：使用 setup-guide 给出的精确 Worker Name 和代码。普通变量通过 Wrangler vars/API 设置，WEBHOOK_SECRET 通过 npx wrangler secret put WEBHOOK_SECRET 或等价 Secret API 设置。Secret 不写入源码、日志、命令回显或最终报告。
6. Rules：scope=all 时编辑 Catch-all address，不要在 Custom address 填写 *、*@域名或任何占位符；Action 设为 Send to a Worker，并选择精确 Worker Name。scope=specific 时创建 Custom address，只填写 @ 前的 local-part，Action 同样为 Send to a Worker。
7. 每次写操作后立即回读 Cloudflare 状态。最后调用 Touch Mail 的域名测试接口验证端到端链路；失败时报告具体阶段、Cloudflare 资源 ID、HTTP 状态和可执行修复建议，不要用“已完成”掩盖未验证步骤。
8. 最终报告必须包含：使用的工具、权限身份、DNS 变更、Worker 名称和版本、Rule 类型与目标、未执行事项、测试结果和回滚方式。`;
}

export function buildDomainAutomationPrompt(input: DomainAutomationPromptInput): string {
  const base = normalizedBaseUrl(input.baseUrl);
  const setupGuideUrl = `${base}/ai/v1/domains/${encodeURIComponent(input.domainId)}/setup-guide?scope=${input.scope}${
    input.scope === "specific" && input.address
      ? `&address=${encodeURIComponent(input.address)}`
      : ""
  }`;
  const general = buildGeneralAutomationPrompt(base);
  const target = `

本次任务参数：
- Domain: ${input.domain}
- Domain ID: ${input.domainId}
- Channel: ${input.channelName} (${input.channelType})
- Scope: ${input.scope}${input.address ? `\n- Address: ${input.address}` : ""}
- Setup guide: ${setupGuideUrl}`;

  if (input.channelType === "worker") {
    const localPart = input.address?.split("@")[0] || "";
    const routingInstruction =
      input.scope === "all"
        ? "配置整个域名时，必须编辑 Catch-all address。不要在 Custom address 中填写 *、*@域名或任何内容。Action 必须是 Send to a Worker。"
        : `配置特定邮箱时，Custom address 只填写 \`${localPart}\`，不要填写完整邮箱；Action 必须是 Send to a Worker。`;
    return `${general}${target}
- Worker Name: ${input.workerName || "从 setup-guide 读取"}

本次执行要求：
1. 先 GET 上述 Setup guide，并按返回的 steps 顺序执行。
2. 确认 ${input.domain} 的 Cloudflare Zone、DNS 和 Email Routing 当前状态。
3. 使用无 Root 的 npx wrangler 或 Cloudflare MCP/API 部署 Worker \`${input.workerName || "setup-guide 中的名称"}\`，配置返回的普通变量和 Secret。
4. ${routingInstruction}
5. 回读 Worker 与 Rule，随后执行 Touch Mail 自动测试；未通过测试不得宣告完成。`;
  }

  if (input.channelType === "email_forward") {
    const source = input.scope === "all" ? `${input.domain} 的 Catch-all/全域转发` : input.address || "setup-guide 中的特定邮箱";
    const collector = input.collectorType === "donemail" ? "DoneMail API" : "签名 Webhook Worker";
    return `${general}${target}
- Forward source: ${source}
- Forward target: ${input.forwardingTarget || "从 setup-guide 读取"}
- Collector: ${collector}

本次执行要求：
1. 先 GET 上述 Setup guide，读取精确转发目标和管理员已配置的 Collector 状态。
2. 这是邮箱转发渠道，不要部署每域 Worker，也不要向域名用户索取 RECEIVE_CHANNEL_ID 或 WEBHOOK_SECRET。
3. scope=all 时使用邮件服务商的 Catch-all、全域转发或邮件流规则，不要把 * 当作普通邮箱地址；scope=specific 时只修改指定邮箱。
4. 将邮件转发到 \`${input.forwardingTarget || "setup-guide 返回的目标"}\`，确认 ${collector} 可用，再执行 Touch Mail 自动测试。`;
  }

  return `${general}${target}

本次执行要求：先读取 Setup guide，按该渠道返回的结构化步骤操作。不要把其他渠道的 Worker、DNS 或 Secret 配置套用到当前渠道；完成后必须执行 Touch Mail 自动测试。`;
}
