const app = document.getElementById("app");

const state = {
  user: null,
  config: null,
  view: "overview",
  loading: true,
  toastTimer: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

async function copyText(text, label = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(label);
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function routeFromHash() {
  const h = (location.hash || "#/").replace(/^#\/?/, "");
  const [page, id] = h.split("/");
  if (!page || page === "login" || page === "register") return { page: "auth", mode: page || "login" };
  if (["overview", "domains", "mails", "worker"].includes(page)) {
    return { page, id: id || null };
  }
  return { page: "overview" };
}

function setHash(path) {
  location.hash = `#/${path}`;
}

// ---------- render ----------

function render() {
  if (state.loading) {
    app.innerHTML = `<div class="shell" style="padding:4rem 0;color:var(--ink-3)">加载中…</div>`;
    return;
  }
  if (!state.user) {
    renderAuth();
    return;
  }
  renderApp();
}

function renderAuth() {
  const route = routeFromHash();
  const mode = route.mode === "register" ? "register" : "login";
  app.innerHTML = `
    <div class="landing">
      <div class="shell topbar">
        <div class="brand"><div class="brand-mark">T</div>Touch Mail</div>
        <div class="muted" style="font-size:.9rem">入站邮件网关 · 无 25 端口</div>
      </div>
      <div class="shell hero">
        <div>
          <h1>把客户邮件收进你的系统</h1>
          <p class="lead">注册账号，拿到专属入站地址。客户邮箱一键转发，Cloudflare Worker 推送到你的云端。</p>
          <ul class="hero-points">
            <li><span class="dot"></span><span>注册登录后即可管理域名与收件箱</span></li>
            <li><span class="dot"></span><span>一键复制 Worker 代码与 wrangler 配置</span></li>
            <li><span class="dot"></span><span>HMAC 验签入站，租户隔离，Message-ID 幂等</span></li>
          </ul>
        </div>
        <div class="auth-card">
          <div class="auth-tabs">
            <button type="button" data-mode="login" class="${mode === "login" ? "active" : ""}">登录</button>
            <button type="button" data-mode="register" class="${mode === "register" ? "active" : ""}">注册</button>
          </div>
          <div id="auth-alert"></div>
          <form id="auth-form">
            ${
              mode === "register"
                ? `<div class="field"><label>显示名称（可选）</label><input name="displayName" placeholder="例如 阿哲" autocomplete="nickname" /></div>`
                : ""
            }
            <div class="field">
              <label>用户名</label>
              <input name="username" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]+" placeholder="小写字母数字下划线" autocomplete="username" />
            </div>
            <div class="field">
              <label>密码</label>
              <input name="password" type="password" required minlength="8" placeholder="至少 8 位" autocomplete="${mode === "register" ? "new-password" : "current-password"}" />
            </div>
            <button class="btn btn-primary btn-block" type="submit">${mode === "register" ? "创建账号" : "登录"}</button>
          </form>
        </div>
      </div>
      <div class="shell footer-note">转发接入长期可用 · 重要客户可再升级子域 MX</div>
    </div>
  `;

  app.querySelectorAll(".auth-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      setHash(btn.dataset.mode);
      renderAuth();
    });
  });

  const form = app.querySelector("#auth-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      username: String(fd.get("username") || "").trim(),
      password: String(fd.get("password") || ""),
      displayName: String(fd.get("displayName") || ""),
    };
    const alert = app.querySelector("#auth-alert");
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const data = await api(path, { method: "POST", body: JSON.stringify(payload) });
      state.user = data.user;
      setHash("overview");
      toast(mode === "register" ? "注册成功" : "欢迎回来");
      render();
    } catch (err) {
      alert.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    } finally {
      submit.disabled = false;
    }
  });
}

function renderApp() {
  const route = routeFromHash();
  const page = route.page;
  app.innerHTML = `
    <div class="app-layout">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">T</div>Touch Mail</div>
        <nav class="nav">
          <button data-nav="overview" class="${page === "overview" ? "active" : ""}">总览</button>
          <button data-nav="domains" class="${page === "domains" ? "active" : ""}">域名</button>
          <button data-nav="mails" class="${page === "mails" || page === "mail" ? "active" : ""}">收件箱</button>
          <button data-nav="worker" class="${page === "worker" ? "active" : ""}">Worker</button>
        </nav>
        <div class="side-user">
          <div class="name">${esc(state.user.displayName || state.user.username)}</div>
          <div class="meta">@${esc(state.user.username)} · ${esc(state.user.tenant)}</div>
          <button class="btn btn-ghost btn-block" id="logout-btn" style="margin-top:.7rem">退出登录</button>
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>
  `;

  app.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setHash(btn.dataset.nav);
      renderApp();
    });
  });
  app.querySelector("#logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    setHash("login");
    render();
  });

  const main = app.querySelector("#main");
  if (page === "domains") loadDomains(main);
  else if (page === "mails") loadMails(main, route.id);
  else if (page === "worker") loadWorker(main);
  else loadOverview(main);
}

async function loadOverview(main) {
  main.innerHTML = `<div class="muted">加载总览…</div>`;
  try {
    const d = await api("/api/dashboard");
    main.innerHTML = `
      <div class="page-head">
        <div>
          <h2>总览</h2>
          <p>你的专属入站地址与最近活动</p>
        </div>
        <span class="pill">tenant · ${esc(d.user.tenant)}</span>
      </div>
      <div class="grid-3">
        <div class="stat">
          <div class="label">入站地址</div>
          <div class="value mono" style="font-size:1rem">${esc(d.inboundAddress)}</div>
        </div>
        <div class="stat">
          <div class="label">登记域名</div>
          <div class="value">${d.domainCount}</div>
        </div>
        <div class="stat">
          <div class="label">最近入站</div>
          <div class="value" style="font-size:1rem">${esc(fmtTime(d.lastMailAt))}</div>
        </div>
      </div>
      <div class="card">
        <h3>快速开始</h3>
        <ol class="steps">
          <li>复制入站地址，在客户邮箱设置「完整转发」</li>
          <li>打开 Worker 页，复制 Cloudflare Email Worker 代码并部署</li>
          <li>在域名页登记客户域名，方便团队台账</li>
          <li>发一封测试信，在收件箱确认到达</li>
        </ol>
        <div class="copy-row" style="margin-top:1rem">
          <code>${esc(d.inboundAddress)}</code>
          <button class="btn btn-primary" id="copy-inbound">复制地址</button>
        </div>
      </div>
      <div class="card">
        <h3>最近邮件</h3>
        ${
          d.recentMails.length
            ? d.recentMails
                .map(
                  (m) => `
            <div class="mail-item" data-mail="${esc(m.id)}">
              <div class="subject">${esc(m.subject || "(无主题)")}</div>
              <div class="meta">${esc(m.from)} · ${esc(fmtTime(m.receivedAt))} · ${esc(m.channel)}</div>
              <div class="muted" style="font-size:.88rem">${esc(m.textPreview || "")}</div>
            </div>`,
                )
                .join("")
            : `<div class="empty">还没有邮件。配置转发后，信件会出现在这里。</div>`
        }
      </div>
    `;
    main.querySelector("#copy-inbound")?.addEventListener("click", () => copyText(d.inboundAddress));
    main.querySelectorAll("[data-mail]").forEach((el) => {
      el.addEventListener("click", () => {
        setHash(`mails/${el.dataset.mail}`);
        renderApp();
      });
    });
  } catch (err) {
    main.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function loadDomains(main) {
  main.innerHTML = `<div class="muted">加载域名…</div>`;
  try {
    const { domains } = await api("/api/domains");
    const inbound = state.user.inboundAddress;
    main.innerHTML = `
      <div class="page-head">
        <div>
          <h2>域名</h2>
          <p>登记客户自有域名（台账）。实际收信请转发到 ${esc(inbound)}</p>
        </div>
      </div>
      <div class="card">
        <h3>添加域名</h3>
        <form class="form-inline" id="domain-form">
          <div class="field" style="margin:0">
            <label>域名</label>
            <input name="domain" required placeholder="customer.com" />
          </div>
          <div class="field" style="margin:0">
            <label>备注</label>
            <input name="note" placeholder="例如 主站 support" />
          </div>
          <button class="btn btn-primary" type="submit">添加</button>
        </form>
        <div id="domain-alert" style="margin-top:.8rem"></div>
      </div>
      <div class="card">
        <h3>已登记</h3>
        ${
          domains.length
            ? `<table class="table">
              <thead><tr><th>域名</th><th>备注</th><th>添加时间</th><th></th></tr></thead>
              <tbody>
                ${domains
                  .map(
                    (d) => `<tr>
                  <td class="mono">${esc(d.domain)}</td>
                  <td class="muted">${esc(d.note || "-")}</td>
                  <td class="muted">${esc(fmtTime(d.createdAt))}</td>
                  <td><button class="btn btn-danger" data-del="${esc(d.id)}">删除</button></td>
                </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>`
            : `<div class="empty">还没有域名。添加后方便区分不同客户业务。</div>`
        }
      </div>
      <div class="card">
        <h3>客户怎么接</h3>
        <ol class="steps">
          <li>把 <code class="mono">${esc(inbound)}</code> 发给客户</li>
          <li>客户在企业邮 / Gmail / M365 设置自动转发到该地址</li>
          <li>可选：客户用 <code class="mono">${esc(state.user.tenant)}+orders@…</code> 区分渠道</li>
        </ol>
      </div>
    `;
    main.querySelector("#domain-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const alert = main.querySelector("#domain-alert");
      try {
        await api("/api/domains", {
          method: "POST",
          body: JSON.stringify({
            domain: fd.get("domain"),
            note: fd.get("note"),
          }),
        });
        toast("已添加");
        loadDomains(main);
      } catch (err) {
        alert.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
    main.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("确定删除该域名？")) return;
        await api(`/api/domains/${btn.dataset.del}`, { method: "DELETE" });
        toast("已删除");
        loadDomains(main);
      });
    });
  } catch (err) {
    main.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function loadMails(main, mailId) {
  main.innerHTML = `<div class="muted">加载收件箱…</div>`;
  try {
    if (mailId) {
      const { mail } = await api(`/api/mails/${mailId}`);
      main.innerHTML = `
        <div class="page-head">
          <div>
            <h2>${esc(mail.subject || "(无主题)")}</h2>
            <p>${esc(mail.from)} → ${esc(mail.to)} · ${esc(fmtTime(mail.receivedAt))}</p>
          </div>
          <button class="btn btn-ghost" id="back-mails">返回列表</button>
        </div>
        <div class="card mail-detail">
          <div class="row-actions">
            <span class="pill">${esc(mail.channel || "default")}</span>
            <span class="muted mono">${esc(mail.messageId || "")}</span>
          </div>
          <div class="body">${esc(mail.text || mail.textPreview || "(无正文)")}</div>
        </div>
      `;
      main.querySelector("#back-mails").addEventListener("click", () => {
        setHash("mails");
        renderApp();
      });
      return;
    }

    const { items } = await api("/api/mails");
    main.innerHTML = `
      <div class="page-head">
        <div>
          <h2>收件箱</h2>
          <p>租户 ${esc(state.user.tenant)} 的入站邮件</p>
        </div>
        <button class="btn btn-ghost" id="refresh-mails">刷新</button>
      </div>
      <div class="card">
        ${
          items.length
            ? items
                .map(
                  (m) => `
          <div class="mail-item" data-mail="${esc(m.id)}">
            <div class="subject">${esc(m.subject || "(无主题)")}</div>
            <div class="meta">${esc(m.from)} · ${esc(fmtTime(m.receivedAt))} · ${esc(m.channel)} · ${m.size}B</div>
            <div class="muted" style="font-size:.88rem">${esc(m.textPreview || "")}</div>
          </div>`,
                )
                .join("")
            : `<div class="empty">暂无邮件</div>`
        }
      </div>
    `;
    main.querySelector("#refresh-mails").addEventListener("click", () => loadMails(main));
    main.querySelectorAll("[data-mail]").forEach((el) => {
      el.addEventListener("click", () => {
        setHash(`mails/${el.dataset.mail}`);
        renderApp();
      });
    });
  } catch (err) {
    main.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function loadWorker(main) {
  main.innerHTML = `<div class="muted">生成 Worker 代码…</div>`;
  try {
    const s = await api("/api/worker-snippet");
    main.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Worker 代码</h2>
          <p>复制到 Cloudflare Email Worker，指向你的入站 webhook</p>
        </div>
      </div>
      <div class="card">
        <h3>部署步骤</h3>
        <ol class="steps">
          ${s.setupSteps.map((x) => `<li>${esc(x)}</li>`).join("")}
        </ol>
        <div class="copy-row" style="margin-top:1rem">
          <code>${esc(s.inboundAddress)}</code>
          <button class="btn btn-primary" id="copy-addr">复制入站地址</button>
        </div>
        <div class="copy-row" style="margin-top:.6rem">
          <code>${esc(s.webhookUrl)}</code>
          <button class="btn btn-ghost" id="copy-url">复制 Webhook</button>
        </div>
      </div>
      <div class="card">
        <div class="page-head" style="margin:0 0 .8rem">
          <h3 style="margin:0">worker.js</h3>
          <button class="btn btn-primary" id="copy-js">复制 JS</button>
        </div>
        <div class="codebox"><pre id="js-code">${esc(s.js)}</pre></div>
      </div>
      <div class="card">
        <div class="page-head" style="margin:0 0 .8rem">
          <h3 style="margin:0">wrangler.toml</h3>
          <button class="btn btn-ghost" id="copy-toml">复制 TOML</button>
        </div>
        <div class="codebox"><pre id="toml-code">${esc(s.wranglerToml)}</pre></div>
      </div>
    `;
    main.querySelector("#copy-addr").addEventListener("click", () => copyText(s.inboundAddress));
    main.querySelector("#copy-url").addEventListener("click", () => copyText(s.webhookUrl));
    main.querySelector("#copy-js").addEventListener("click", () => copyText(s.js, "Worker JS 已复制"));
    main.querySelector("#copy-toml").addEventListener("click", () => copyText(s.wranglerToml, "TOML 已复制"));
  } catch (err) {
    main.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

// ---------- boot ----------
async function boot() {
  try {
    const [cfg, me] = await Promise.all([api("/api/config"), api("/api/auth/me")]);
    state.config = cfg;
    state.user = me.user;
    if (state.user) {
      state.user.inboundAddress = `${state.user.tenant}@${cfg.inboundDomain}`;
    }
  } catch (err) {
    console.error(err);
  } finally {
    state.loading = false;
    render();
  }
}

window.addEventListener("hashchange", () => {
  if (state.loading) return;
  render();
});

boot();
