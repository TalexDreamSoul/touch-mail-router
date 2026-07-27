import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FeishuSettings, LoginChannel } from "./db.js";

export interface OAuthProfile {
  subject: string;
  username: string;
  displayName: string;
}

type OidcDiscovery = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
};

const REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;

export interface OAuthCookieState {
  channelId: string;
  state: string;
  verifier: string;
  createdAt: number;
}

export function sealOAuthState(value: OAuthCookieState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function unsealOAuthState(
  token: string,
  secret: string,
  now = Date.now(),
): OAuthCookieState | null {
  const [payload, encodedSignature, ...extra] = token.split(".");
  if (!payload || !encodedSignature || extra.length) return null;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  const expected = Buffer.from(expectedSignature, "utf8");
  const provided = Buffer.from(encodedSignature, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthCookieState;
    if (
      typeof parsed.channelId !== "string" ||
      !parsed.channelId ||
      typeof parsed.state !== "string" ||
      !parsed.state ||
      typeof parsed.verifier !== "string" ||
      parsed.verifier.length < 43 ||
      !Number.isFinite(parsed.createdAt) ||
      parsed.createdAt > now + 60_000 ||
      now - parsed.createdAt > OAUTH_STATE_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function endpointUrl(value: unknown, label: string): string {
  const raw = String(value || "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} 地址无效`);
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    )
  ) {
    throw new Error(`${label} 必须使用 HTTPS；仅本机开发允许 HTTP`);
  }
  return url.toString();
}

async function requestJson(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${label}请求失败：${error instanceof Error ? error.message : "网络错误"}`);
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = String(data.error_description || data.msg || data.error || response.statusText);
    throw new Error(`${label}失败（${response.status}）：${detail}`);
  }
  return data;
}

async function discoverOidc(channel: LoginChannel): Promise<OidcDiscovery> {
  const issuer = channel.issuer.replace(/\/$/, "");
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const discovery = (await requestJson(discoveryUrl, { method: "GET" }, "OIDC Discovery")) as OidcDiscovery;
  if (String(discovery.issuer || "").replace(/\/$/, "") !== issuer) {
    throw new Error("OIDC Discovery 返回的 issuer 与配置不一致");
  }
  endpointUrl(discovery.authorization_endpoint, "OIDC Authorization Endpoint");
  endpointUrl(discovery.token_endpoint, "OIDC Token Endpoint");
  endpointUrl(discovery.userinfo_endpoint, "OIDC UserInfo Endpoint");
  return discovery;
}

function claimValue(profile: Record<string, unknown>, claim: string): string {
  let current: unknown = profile;
  for (const part of claim.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return "";
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" || typeof current === "number" ? String(current) : "";
}

export async function buildOAuthAuthorizationUrl(
  channel: LoginChannel,
  feishu: FeishuSettings,
  callbackUrl: string,
  state: string,
  verifier: string,
): Promise<string> {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (channel.type === "feishu") {
    if (!feishu.enabled || !feishu.appId || !feishu.appSecret) {
      throw new Error("飞书配置未启用或凭证不完整");
    }
    const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    url.searchParams.set("client_id", feishu.appId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  const discovery = await discoverOidc(channel);
  const url = new URL(String(discovery.authorization_endpoint));
  url.searchParams.set("client_id", channel.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", channel.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeOAuthProfile(
  channel: LoginChannel,
  feishu: FeishuSettings,
  callbackUrl: string,
  code: string,
  verifier: string,
): Promise<OAuthProfile> {
  if (channel.type === "feishu") {
    if (!feishu.enabled || !feishu.appId || !feishu.appSecret) {
      throw new Error("飞书配置未启用或凭证不完整");
    }
    const token = await requestJson(
      "https://accounts.feishu.cn/oauth/v3/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: feishu.appId,
          client_secret: feishu.appSecret,
          code,
          redirect_uri: callbackUrl,
          code_verifier: verifier,
        }),
      },
      "飞书 Token 交换",
    );
    const accessToken = String(token.access_token || "");
    if (!accessToken || Number(token.code || 0) !== 0) {
      throw new Error(`飞书 Token 交换失败：${String(token.error_description || token.error || token.code || "响应无 access_token")}`);
    }
    const userInfo = await requestJson(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
      "飞书用户信息",
    );
    if (Number(userInfo.code || 0) !== 0) {
      throw new Error(`飞书用户信息失败：${String(userInfo.msg || userInfo.code)}`);
    }
    const profile = (userInfo.data || {}) as Record<string, unknown>;
    return {
      subject: String(profile.union_id || profile.open_id || ""),
      username: String(profile.email || profile.enterprise_email || profile.name || ""),
      displayName: String(profile.name || profile.en_name || ""),
    };
  }

  const discovery = await discoverOidc(channel);
  const tokenEndpoint = endpointUrl(discovery.token_endpoint, "OIDC Token Endpoint");
  const methods = Array.isArray(discovery.token_endpoint_auth_methods_supported)
    ? discovery.token_endpoint_auth_methods_supported
    : ["client_secret_basic"];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: channel.clientId,
    code,
    redirect_uri: callbackUrl,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (methods.includes("client_secret_basic")) {
    headers.Authorization = `Basic ${Buffer.from(`${channel.clientId}:${channel.clientSecret}`).toString("base64")}`;
  } else if (methods.includes("client_secret_post")) {
    body.set("client_secret", channel.clientSecret);
  } else {
    throw new Error("OIDC Provider 不支持 client_secret_basic 或 client_secret_post");
  }
  const token = await requestJson(
    tokenEndpoint,
    { method: "POST", headers, body: body.toString() },
    "OIDC Token 交换",
  );
  const accessToken = String(token.access_token || "");
  if (!accessToken) throw new Error("OIDC Token 响应缺少 access_token");
  const profile = await requestJson(
    endpointUrl(discovery.userinfo_endpoint, "OIDC UserInfo Endpoint"),
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
    "OIDC UserInfo",
  );
  return {
    subject: claimValue(profile, channel.subjectClaim),
    username:
      claimValue(profile, channel.usernameClaim) ||
      claimValue(profile, "email") ||
      claimValue(profile, channel.subjectClaim),
    displayName:
      claimValue(profile, channel.displayNameClaim) ||
      claimValue(profile, channel.usernameClaim) ||
      claimValue(profile, "email"),
  };
}
