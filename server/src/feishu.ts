export type FeishuConnectionConfig = {
  appId: string;
  appSecret: string;
  notifyChatId: string;
};

export type FeishuTestErrorKind = "validation" | "remote" | "network" | "timeout";

export type FeishuTestErrorDetails = {
  phase: string;
  endpoint?: string;
  method?: string;
  request?: unknown;
  upstreamStatus?: number;
  feishuCode?: number | string;
  responseHeaders?: Record<string, string>;
  response?: unknown;
  suggestion?: string;
  durationMs?: number;
  occurredAt?: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type FeishuResponse = {
  code?: number | string;
  msg?: string;
  tenant_access_token?: string;
  [key: string]: unknown;
};

export class FeishuTestError extends Error {
  constructor(
    message: string,
    public readonly kind: FeishuTestErrorKind,
    public readonly details: FeishuTestErrorDetails,
  ) {
    super(message);
    this.name = "FeishuTestError";
  }
}

function redactString(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .slice(0, 4_000);
}

function sanitizeResponse(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeResponse(item, secrets, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /secret|token|authorization|credential/i.test(key)
          ? "[REDACTED]"
          : sanitizeResponse(item, secrets, depth + 1),
      ]),
  );
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([key]) => !/authorization|cookie|secret|token/i.test(key))
      .slice(0, 50),
  );
}

function suggestionFor(
  code: number | string | undefined,
  phase: string,
): string | undefined {
  if (String(code) === "99991672") {
    return phase === "获取群列表"
      ? "在飞书开放平台开通 im:chat 权限，并确保机器人已加入目标群后重试。"
      : "在飞书开放平台为应用开通 im:message:send_as_bot 权限，并发布新版本后重试。";
  }
  if (String(code) === "230006" || String(code) === "232025") {
    return "在飞书开放平台进入应用的“应用能力 → 机器人”，启用机器人能力并发布新版本；随后将机器人加入目标群。";
  }
  if (String(code) === "10003") {
    return "核对当前阶段的请求参数；若发生在发送消息阶段，请确认 Chat ID 是以 oc_ 开头的群 ID。";
  }
  return undefined;
}

async function requestFeishu(
  endpoint: string,
  phase: string,
  init: RequestInit,
  request: unknown,
  startedAt: number,
  secrets: string[],
  fetchImpl: FetchLike,
): Promise<Response> {
  try {
    return await fetchImpl(`https://open.feishu.cn${endpoint}`, init);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    const timeout = errorName === "TimeoutError" || errorName === "AbortError";
    throw new FeishuTestError(
      timeout
        ? `${phase}超时，请稍后重试`
        : `${phase}失败：${redactString(
            error instanceof Error ? error.message : "网络请求异常",
            secrets,
          )}`,
      timeout ? "timeout" : "network",
      {
        phase,
        endpoint,
        method: init.method || "GET",
        request,
        durationMs: Date.now() - startedAt,
        occurredAt: new Date().toISOString(),
      },
    );
  }
}

async function readFeishuResponse(
  response: Response,
  phase: string,
  endpoint: string,
  method: string,
  request: unknown,
  startedAt: number,
  secrets: string[],
): Promise<FeishuResponse> {
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }
  const data: FeishuResponse =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as FeishuResponse)
      : {
          msg: redactString(raw || `HTTP ${response.status}`, secrets),
          response: sanitizeResponse(parsed ?? raw, secrets),
        };

  if (!response.ok || data.code !== 0) {
    const message = redactString(String(data.msg || `HTTP ${response.status}`), secrets);
    throw new FeishuTestError(
      `${phase}失败：${message}`,
      "remote",
      {
        phase,
        endpoint,
        method,
        request,
        upstreamStatus: response.status,
        feishuCode: data.code,
        responseHeaders: safeResponseHeaders(response.headers),
        response: sanitizeResponse(data, secrets),
        suggestion: suggestionFor(data.code, phase),
        durationMs: Date.now() - startedAt,
        occurredAt: new Date().toISOString(),
      },
    );
  }
  return data;
}

async function getTenantAccessToken(
  appIdRaw: string,
  appSecretRaw: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const appId = appIdRaw.trim();
  const appSecret = appSecretRaw.trim();
  if (!appId) {
    throw new FeishuTestError("请填写 App ID", "validation", { phase: "配置校验" });
  }
  if (!appSecret) {
    throw new FeishuTestError("请填写 App Secret", "validation", { phase: "配置校验" });
  }

  const authEndpoint = "/open-apis/auth/v3/tenant_access_token/internal";
  const authRequest = { app_id: appId, app_secret: "[CONFIGURED]" };
  const authStartedAt = Date.now();
  const authResponse = await requestFeishu(
    authEndpoint,
    "获取访问凭据",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    },
    authRequest,
    authStartedAt,
    [appSecret],
    fetchImpl,
  );
  const auth = await readFeishuResponse(
    authResponse,
    "获取访问凭据",
    authEndpoint,
    "POST",
    authRequest,
    authStartedAt,
    [appSecret],
  );
  if (!auth.tenant_access_token) {
    throw new FeishuTestError("飞书未返回 tenant access token", "remote", {
      phase: "获取访问凭据",
      endpoint: authEndpoint,
      method: "POST",
      request: authRequest,
      upstreamStatus: authResponse.status,
      responseHeaders: safeResponseHeaders(authResponse.headers),
      response: sanitizeResponse(auth, [appSecret]),
      durationMs: Date.now() - authStartedAt,
      occurredAt: new Date().toISOString(),
    });
  }
  return auth.tenant_access_token;
}

async function sendFeishuText(
  config: FeishuConnectionConfig,
  text: string,
  phase: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const appSecret = config.appSecret.trim();
  const notifyChatId = config.notifyChatId.trim();
  if (!notifyChatId) {
    throw new FeishuTestError("请配置通知群 Chat ID", "validation", { phase: "配置校验" });
  }
  const tenantAccessToken = await getTenantAccessToken(config.appId, appSecret, fetchImpl);
  const messageEndpoint = "/open-apis/im/v1/messages?receive_id_type=chat_id";
  const messageRequest = {
    receive_id: notifyChatId,
    msg_type: "text",
    content: { text },
  };
  const messageStartedAt = Date.now();
  const messageResponse = await requestFeishu(
    messageEndpoint,
    phase,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenantAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: notifyChatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
      signal: AbortSignal.timeout(10_000),
    },
    messageRequest,
    messageStartedAt,
    [appSecret, tenantAccessToken],
    fetchImpl,
  );
  await readFeishuResponse(
    messageResponse,
    phase,
    messageEndpoint,
    "POST",
    messageRequest,
    messageStartedAt,
    [appSecret, tenantAccessToken],
  );
}

export async function testFeishuConnection(
  config: FeishuConnectionConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ messageSent: boolean }> {
  if (!config.notifyChatId.trim()) {
    await getTenantAccessToken(config.appId, config.appSecret, fetchImpl);
    return { messageSent: false };
  }
  const messageText = `TouchMail 飞书集成测试成功\n测试时间：${new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  })}`;
  await sendFeishuText(config, messageText, "发送测试消息", fetchImpl);
  return { messageSent: true };
}

export async function sendFeishuNotification(
  config: FeishuConnectionConfig,
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await sendFeishuText(config, text, "发送入站通知", fetchImpl);
}

export type FeishuChat = {
  chatId: string;
  name: string;
  description: string;
  avatar: string;
};

export async function listFeishuChats(
  config: Pick<FeishuConnectionConfig, "appId" | "appSecret">,
  fetchImpl: FetchLike = fetch,
): Promise<{ items: FeishuChat[] }> {
  const appSecret = config.appSecret.trim();
  const tenantAccessToken = await getTenantAccessToken(config.appId, appSecret, fetchImpl);
  const endpoint = "/open-apis/im/v1/chats?page_size=100";
  const request = { page_size: 100 };
  const startedAt = Date.now();
  const response = await requestFeishu(
    endpoint,
    "获取群列表",
    {
      method: "GET",
      headers: { authorization: `Bearer ${tenantAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    },
    request,
    startedAt,
    [appSecret, tenantAccessToken],
    fetchImpl,
  );
  const result = await readFeishuResponse(
    response,
    "获取群列表",
    endpoint,
    "GET",
    request,
    startedAt,
    [appSecret, tenantAccessToken],
  );
  const data = result.data;
  const items =
    data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
      ? ((data as { items: unknown[] }).items)
      : [];

  return {
    items: items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const chat = item as Record<string, unknown>;
      const chatId = String(chat.chat_id || "").trim();
      if (!chatId) return [];
      return [{
        chatId,
        name: String(chat.name || chatId),
        description: String(chat.description || ""),
        avatar: String(chat.avatar || ""),
      }];
    }),
  };
}
