/**
 * Admin 前端页面模板
 */

export function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KeyPool 控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070b14;
      --bg2: #0c1426;
      --panel: #121a2b;
      --panel2: #18233a;
      --panel3: #202d49;
      --border: #2d3859;
      --border-strong: #3f5384;
      --text: #edf4ff;
      --muted: #97a6c9;
      --soft: #c5d1ea;
      --accent: #66a3ff;
      --accent2: #7dd3fc;
      --ok: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
      --shadow: 0 18px 60px rgba(0, 0, 0, .32);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif; background: radial-gradient(circle at 16% -10%, rgba(102,163,255,.24), transparent 36%), radial-gradient(circle at 88% 4%, rgba(52,211,153,.16), transparent 28%), linear-gradient(180deg, var(--bg2), var(--bg)); color: var(--text); min-height: 100vh; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 28px; }
    .header, .toolbar, .tabs, .meta-links, .banner-actions, .control-actions { display: flex; gap: 12px; flex-wrap: wrap; }
    .header { justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
    .title h1 { margin: 0; font-size: clamp(26px, 3vw, 36px); letter-spacing: -.04em; }
    .title p { margin: 7px 0 0; color: var(--muted); }
    .toolbar { margin: 0; align-items: center; }
    .banner { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: center; margin-bottom: 14px; background: linear-gradient(135deg, rgba(102,163,255,.18), rgba(52,211,153,.09)); border: 1px solid rgba(102,163,255,.35); border-radius: 22px; padding: 20px; box-shadow: var(--shadow); }
    .banner-main { min-width: 0; }
    .banner code { display: block; margin-top: 6px; color: var(--accent2); font-size: 16px; word-break: break-all; }
    .service-badges { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .manager-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; margin-bottom: 18px; background: rgba(18,26,43,.78); border: 1px solid var(--border); border-radius: 18px; padding: 16px 18px; }
    .manager-panel h2, .metric-group h2 { margin: 0; font-size: 15px; letter-spacing: .01em; }
    .manager-panel p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .summary-groups { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
    .metric-group { background: rgba(18,26,43,.86); border: 1px solid var(--border); border-radius: 18px; padding: 14px; }
    .metric-group-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
    .metric-group-sub { color: var(--muted); font-size: 12px; }
    .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .metric { position: relative; overflow: hidden; min-height: 86px; background: linear-gradient(180deg, rgba(32,45,73,.92), rgba(18,26,43,.92)); border: 1px solid var(--border); border-radius: 14px; padding: 12px; }
    .metric::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); opacity: .8; }
    .metric.ok::before { background: var(--ok); }
    .metric.warn::before { background: var(--warn); }
    .metric.bad::before { background: var(--bad); }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { font-size: 28px; font-weight: 800; margin-top: 6px; letter-spacing: -.03em; }
    .metric.wide { grid-column: 1 / -1; }
    .card { background: rgba(18,26,43,.9); border: 1px solid var(--border); border-radius: 16px; padding: 16px; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .btn, select { border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 11px; padding: 8px 12px; font: inherit; }
    .btn { cursor: pointer; transition: transform .15s ease, border-color .15s ease, filter .15s ease; }
    .btn:hover { filter: brightness(1.08); border-color: var(--border-strong); transform: translateY(-1px); }
    .btn.primary { background: linear-gradient(135deg, rgba(102,163,255,.38), rgba(125,211,252,.18)); border-color: rgba(102,163,255,.55); }
    .btn.ok-btn { border-color: rgba(52,211,153,.46); color: #c8ffe9; }
    .btn.bad-btn { border-color: rgba(248,113,113,.46); color: #ffd7d7; }
    .tabs { background: rgba(18,26,43,.68); border: 1px solid var(--border); border-radius: 16px; padding: 6px; margin: 18px 0 14px; }
    .tab { padding: 9px 14px; color: var(--muted); cursor: pointer; border-radius: 11px; }
    .tab.active { color: var(--text); background: rgba(102,163,255,.16); box-shadow: inset 0 0 0 1px rgba(102,163,255,.25); }
    .panel { display: none; }
    .panel.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
    .card h3 { margin: 0 0 6px; font-size: 16px; }
    .sub { color: var(--muted); font-size: 12px; }
    .kv { display: grid; grid-template-columns: 110px 1fr; gap: 6px 10px; margin-top: 10px; font-size: 13px; }
    .k { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    .table-wrap { overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel2); font-size: 12px; }
    .empty { color: var(--muted); text-align: center; padding: 30px; min-height: 120px; display: grid; place-items: center; }
    .api-drawer { margin-top: 18px; background: rgba(18,26,43,.62); border: 1px solid var(--border); border-radius: 16px; padding: 12px 14px; }
    .api-drawer summary { cursor: pointer; color: var(--soft); }
    .meta-links { margin-top: 12px; }
    .meta-links a { padding: 6px 9px; border-radius: 999px; background: rgba(102,163,255,.09); }
    .action-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .action-row .btn { padding: 6px 10px; font-size: 12px; }
    .status-line { margin-top: 8px; color: var(--muted); font-size: 12px; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(4, 8, 18, 0.72); display: none; align-items: center; justify-content: center; padding: 20px; z-index: 50; }
    .modal-backdrop.open { display: flex; }
    .modal { width: min(680px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
    .modal h3 { margin: 0 0 6px; font-size: 18px; }
    .modal p { margin: 0 0 14px; color: var(--muted); }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label { color: var(--muted); font-size: 12px; }
    .field input, .field textarea, .field select { width: 100%; border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 10px; padding: 10px 12px; font: inherit; }
    .field textarea { min-height: 120px; resize: vertical; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 4px; }
    @media (max-width: 980px) { .summary-groups, .banner, .manager-panel { grid-template-columns: 1fr; } }
    @media (max-width: 720px) { .shell { padding: 18px; } .form-grid, .metric-grid { grid-template-columns: 1fr; } .header { gap: 16px; } }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .toast-container { position: fixed; top: 20px; right: 20px; z-index: 100; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { pointer-events: auto; padding: 12px 18px; border-radius: 12px; font-size: 14px; color: var(--text); background: var(--panel2); border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,.35); transform: translateX(120%); transition: transform .3s ease; max-width: 360px; word-break: break-word; }
    .toast.show { transform: translateX(0); }
    .toast.ok { border-color: var(--ok); }
    .toast.warn { border-color: var(--warn); }
    .toast.bad { border-color: var(--bad); }
    .card-toggle { cursor: pointer; color: var(--accent); font-size: 12px; margin-top: 8px; display: inline-block; }
    .card-toggle:hover { text-decoration: underline; }
    .card-extra { display: none; }
    .card-extra.expanded { display: block; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; filter: none; transform: none; }
    .btn .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .6s linear infinite; margin-right: 4px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="toast-container" id="toastContainer"></div>
  <div class="shell">
    <div class="header">
      <div class="title">
        <h1>KeyPool 控制台</h1>
        <p>Tunnel proxy 运行视图：Gateway / Manager / 实例 / 账号状态总览</p>
      </div>
      <div class="toolbar">
        <select id="refreshMs">
          <option value="0">自动刷新：关</option>
          <option value="5000">5 秒</option>
          <option value="10000" selected>10 秒</option>
          <option value="30000">30 秒</option>
        </select>
        <button class="btn" id="refreshBtn">刷新</button>
      </div>
    </div>

    <div class="banner">
      <div class="banner-main">
        <div class="sub">接入地址</div>
        <code id="accessUrl">-</code>
        <div class="service-badges" id="serviceBadges"></div>
      </div>
      <div class="banner-actions">
        <button class="btn primary" id="copyBtn">复制接入地址</button>
      </div>
    </div>

    <div class="manager-panel">
      <div>
        <h2>Manager 控制</h2>
        <p>控制 KeyPool Manager 后台进程。启动、重启、停止都会触发状态刷新。</p>
      </div>
      <div class="control-actions">
        <button class="btn ok-btn" id="startManagerBtn">启动 Manager</button>
        <button class="btn primary" id="restartManagerBtn">重启 Manager</button>
        <button class="btn bad-btn" id="stopManagerBtn">停止 Manager</button>
      </div>
    </div>

    <div class="summary-groups" id="metrics"></div>

    <div class="tabs">
      <div class="tab active" data-tab="instances">实例</div>
      <div class="tab" data-tab="accounts">账号</div>
      <div class="tab" data-tab="audit">审计</div>
    </div>

    <div class="panel active" data-panel="instances">
      <div class="toolbar" style="margin-bottom: 12px;">
        <select id="instanceStatusFilter">
          <option value="">全部状态</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="FAILED">FAILED</option>
          <option value="DEPLOYING">DEPLOYING</option>
          <option value="DEPLOYED_UNVERIFIED">DEPLOYED_UNVERIFIED</option>
          <option value="CREATING">CREATING</option>
          <option value="READY">READY</option>
          <option value="PAUSED">PAUSED</option>
          <option value="MANUAL_STOPPED">MANUAL_STOPPED</option>
          <option value="DESTROYED">DESTROYED</option>
          <option value="NONE">NONE</option>
        </select>
      </div>
      <div class="grid" id="instancesGrid"></div>
    </div>
    <div class="panel" data-panel="accounts">
      <div class="table-wrap">
        <div class="toolbar">
          <button class="btn" id="newAccountBtn">新增账号</button>
          <select id="accountEnabledFilter">
            <option value="">全部</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已禁用</option>
          </select>
        </div>
        <table>
          <thead><tr><th>ID</th><th>名称</th><th>实例状态</th><th>启用</th><th>优先级</th><th>Weight</th><th>标签</th><th>Cookie</th><th>操作</th></tr></thead>
          <tbody id="accountsBody"></tbody>
        </table>
      </div>
    </div>
    <div class="panel" data-panel="audit">
      <div class="table-wrap">
        <div class="toolbar">
          <button class="btn" id="refreshAuditBtn">刷新审计日志</button>
          <select id="auditActionFilter">
            <option value="">全部操作</option>
            <option value="account.create">account.create</option>
            <option value="account.update">account.update</option>
            <option value="account.delete">account.delete</option>
            <option value="account.cookie">account.cookie</option>
            <option value="account.deploy">account.deploy</option>
            <option value="account.recover">account.recover</option>
            <option value="account.destroy">account.destroy</option>
            <option value="account.stop">account.stop</option>
            <option value="account.pause">account.pause</option>
            <option value="account.renew">account.renew</option>
            <option value="manager.start">manager.start</option>
            <option value="manager.stop">manager.stop</option>
            <option value="manager.reload">manager.reload</option>
          </select>
          <select id="auditResultFilter">
            <option value="">全部结果</option>
            <option value="ok">成功</option>
            <option value="fail">失败</option>
          </select>
        </div>
        <table>
          <thead><tr><th>时间</th><th>操作</th><th>目标</th><th>详情</th><th>结果</th></tr></thead>
          <tbody id="auditBody"></tbody>
        </table>
      </div>
    </div>

    <details class="api-drawer">
      <summary>API 资源链接</summary>
      <div class="meta-links">
        <a href="/health" target="_blank">/health</a>
        <a href="/admin/api/overview" target="_blank">/admin/api/overview</a>
        <a href="/admin/api/instances" target="_blank">/admin/api/instances</a>
        <a href="/admin/api/accounts" target="_blank">/admin/api/accounts</a>
        <a href="/admin/api/audit" target="_blank">/admin/api/audit</a>
        <a href="/admin/api/control/status" target="_blank">/admin/api/control/status</a>
      </div>
    </details>
  </div>

  <div class="modal-backdrop" id="accountModalBackdrop" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="accountModalTitle">
      <h3 id="accountModalTitle">账号管理</h3>
      <p id="accountModalSubtitle">新增或编辑账号配置。保存后会自动写回 accounts.json。</p>
      <form id="accountForm">
        <input type="hidden" id="accountOriginalId">
        <div class="form-grid">
          <div class="field">
            <label for="accountIdInput">账号 ID</label>
            <input id="accountIdInput" name="id" required>
          </div>
          <div class="field">
            <label for="accountNameInput">名称</label>
            <input id="accountNameInput" name="name" required>
          </div>
          <div class="field">
            <label for="accountEnabledInput">是否启用</label>
            <select id="accountEnabledInput" name="enabled">
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          </div>
          <div class="field">
            <label for="accountPriorityInput">优先级</label>
            <input id="accountPriorityInput" name="priority" type="number" step="1" value="100">
          </div>
          <div class="field">
            <label for="accountWeightInput">Weight（权重）</label>
            <input id="accountWeightInput" name="weight" type="number" step="1" min="0" value="100">
            <div class="hint">同优先级层内负载均衡权重，0 仍有基础概率。默认 100。</div>
          </div>
          <div class="field full">
            <label for="accountTagsInput">标签</label>
            <input id="accountTagsInput" name="tags" placeholder="例如：main, cn, backup">
          </div>
          <div class="field full">
            <label for="accountCookieInput">Cookie</label>
            <textarea id="accountCookieInput" name="cookie" placeholder="新增账号时必填；编辑时留空表示不修改现有 Cookie"></textarea>
            <div class="hint" id="accountCookieHint">新增账号时必须填写 Cookie；编辑时可留空，表示保持原值不变。</div>
          </div>
          <div class="field full">
            <label for="accountMetaInput">Meta（JSON，可选）</label>
            <textarea id="accountMetaInput" name="meta" placeholder='{"key": "value"}'></textarea>
            <div class="hint">自定义元数据，JSON 对象格式。留空或 {} 表示无额外信息。</div>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancelAccountBtn">取消</button>
          <button type="submit" class="btn" id="saveAccountBtn">保存</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const state = { timer: null, accounts: [], instances: [], modalMode: 'create', activeTab: 'instances', expandedCards: new Set() };
    function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
    function fmtAgo(ms) { if (!Number.isFinite(ms) || ms < 0) return '-'; if (ms < 1000) return ms + 'ms'; const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
    function fmtDateTime(value) { if (!value) return '-'; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return date.toLocaleString('zh-CN', { hour12: false }); }
    function statusPill(status) { const cls = ['ACTIVE','READY'].includes(status) ? 'ok' : ['FAILED','DESTROYED'].includes(status) ? 'bad' : 'warn'; return '<span class="pill ' + cls + '">' + escapeHtml(status || 'NONE') + '</span>'; }
    function metricCard(label, value, cls = '') { return '<div class="metric ' + cls + '"><div class="label">' + escapeHtml(label) + '</div><div class="value ' + cls + '">' + escapeHtml(value) + '</div></div>'; }
    function metricGroup(title, subtitle, cards) { return '<section class="metric-group"><div class="metric-group-head"><h2>' + escapeHtml(title) + '</h2><span class="metric-group-sub">' + escapeHtml(subtitle) + '</span></div><div class="metric-grid">' + cards.join('') + '</div></section>'; }
    function actionButtons(accountId, status) { const isPaused = status === 'PAUSED'; const isStopped = status === 'MANUAL_STOPPED'; const isFailed = status === 'FAILED'; const isDestroyed = status === 'DESTROYED'; const isActive = status === 'ACTIVE'; return '<div class="action-row">' + '<button class="btn" data-action="deploy" data-account="' + escapeHtml(accountId) + '">部署</button>' + '<button class="btn" data-action="recover" data-account="' + escapeHtml(accountId) + '">恢复</button>' + (isActive ? '<button class="btn" data-action="pause" data-account="' + escapeHtml(accountId) + '">暂停</button>' : '') + (isPaused ? '<button class="btn" data-action="deploy" data-account="' + escapeHtml(accountId) + '">恢复部署</button>' : '') + '<button class="btn" data-action="renew" data-account="' + escapeHtml(accountId) + '">续期</button>' + '<button class="btn bad-btn" data-action="destroy" data-account="' + escapeHtml(accountId) + '">销毁</button>' + '<button class="btn" data-action="stop" data-account="' + escapeHtml(accountId) + '">停止</button>' + '</div>'; }
    async function postJson(url) { const resp = await fetch(url, { method: 'POST' }); const text = await resp.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; } if (!resp.ok) { throw new Error(data?.message || data?.error || ('HTTP ' + resp.status)); } return data; }
    async function refresh() {
      const [overviewRes, instancesRes, accountsRes] = await Promise.allSettled([
        fetch('/admin/api/overview', { cache: 'no-store' }).then(r => r.json()),
        fetch('/admin/api/instances', { cache: 'no-store' }).then(r => r.json()),
        fetch('/admin/api/accounts', { cache: 'no-store' }).then(r => r.json())
      ]);
      const overview = overviewRes.status === 'fulfilled' ? overviewRes.value : null;
      const instancesData = instancesRes.status === 'fulfilled' ? instancesRes.value : { instances: {} };
      const accountsData = accountsRes.status === 'fulfilled' ? accountsRes.value : { accounts: [] };
      if (overview) renderOverview(overview);
      if (instancesRes.status === 'rejected') showToast('实例数据加载失败', 'warn');
      if (accountsRes.status === 'rejected') showToast('账号数据加载失败', 'warn');
      state.accounts = accountsData.accounts || [];
      state.instances = Object.values(instancesData.instances || {});
      window.__lastInstances = instancesData.instances || {};
      applyInstanceFilter();
      renderAccounts(state.accounts, instancesData.instances || {});
      if (state.activeTab === 'audit') { try { await refreshAudit(); } catch {} }
    }
    function renderOverview(data) {
      const serviceStatus = data?.service?.status || '-';
      const managerRunning = Boolean(data?.service?.manager?.running);
      const m = data?.metrics || {};
      document.getElementById('accessUrl').textContent = data?.service?.accessUrl || '-';
      const badges = document.getElementById('serviceBadges');
      if (badges) {
        badges.innerHTML = '<span class="pill ' + (serviceStatus === 'ok' ? 'ok' : 'warn') + '">服务 ' + escapeHtml(serviceStatus) + '</span>' + '<span class="pill ' + (managerRunning ? 'ok' : 'warn') + '">Manager ' + escapeHtml(managerRunning ? '运行中' : '未运行') + '</span>';
      }
      document.getElementById('metrics').innerHTML = [
        metricGroup('Tunnel 实例', '当前主运行节点', [
          metricCard('实例总数', m.instances ?? 0),
          metricCard('运行中', m.activeInstances ?? 0, 'ok'),
          metricCard('已验证', m.verifiedInstances ?? 0, 'ok'),
          metricCard('异常', m.failedInstances ?? 0, (m.failedInstances ?? 0) > 0 ? 'bad' : '')
        ]),
        metricGroup('账号容量', '账号配置与可用性', [
          metricCard('账号总数', m.accounts ?? 0),
          metricCard('已启用', m.enabledAccounts ?? 0, 'ok'),
          metricCard('可重试失败', m.retryableFailures ?? 0, (m.retryableFailures ?? 0) > 0 ? 'warn' : ''),
          metricCard('创建中', m.creatingInstances ?? 0, (m.creatingInstances ?? 0) > 0 ? 'warn' : '')
        ]),
        metricGroup('服务状态', 'Gateway 运行信息', [
          metricCard('服务状态', serviceStatus, serviceStatus === 'ok' ? 'ok' : 'warn'),
          metricCard('Manager', managerRunning ? '运行中' : '未运行', managerRunning ? 'ok' : 'warn')
        ])
      ].join('');
    }
    function fmtRemaining(ms) { if (!Number.isFinite(ms) || ms <= 0) return '-'; const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
    function applyInstanceFilter() { const filter = document.getElementById('instanceStatusFilter')?.value || ''; const filtered = filter ? state.instances.filter(item => item.status === filter) : state.instances; renderInstances(filtered); }
    function renderInstances(instances) { const root = document.getElementById('instancesGrid'); if (!instances.length) { root.innerHTML = '<div class="card empty">当前还没有实例状态记录</div>'; return; } root.innerHTML = instances.map(item => { const id = 'inst-' + escapeHtml(item.accountId); return '<div class="card">' + '<h3>' + escapeHtml(item.accountId) + '</h3>' + '<div class="sub">' + statusPill(item.status) + '</div>' + '<div class="kv">' + '<div class="k">部署模式</div><div class="v">' + escapeHtml(item.deployMode || '-') + '</div>' + '<div class="k">已验证</div><div class="v">' + escapeHtml(item.verified ? '是' : '否') + '</div>' + '<div class="k">Health OK</div><div class="v">' + escapeHtml(item.healthOk ? '是' : '否') + '</div>' + '<div class="k">部署阶段</div><div class="v">' + escapeHtml(item.deployStage || '-') + ' / ' + escapeHtml(item.deployStatus || '-') + '</div>' + '<div class="k">部署次数</div><div class="v">' + escapeHtml(item.deployCount || 0) + '</div>' + '<div class="k">权重/优先级</div><div class="v">' + escapeHtml(item.weight ?? 100) + ' / ' + escapeHtml(item.priority ?? 100) + '</div>' + '<div class="k">剩余时间</div><div class="v ' + ((item.remaining != null && item.remaining < 300000) ? 'warn' : '') + '">' + escapeHtml(fmtRemaining(item.remaining)) + '</div>' + '<div class="k">创建时间</div><div class="v">' + escapeHtml(fmtDateTime(item.createdAt)) + '</div>' + '<div class="k">过期时间</div><div class="v">' + escapeHtml(fmtDateTime(item.expiresAt)) + '</div>' + '<div class="k">最近使用</div><div class="v">' + escapeHtml(fmtDateTime(item.lastUsedAt)) + '</div>' + '<div class="k">代理延迟</div><div class="v">' + (Number.isFinite(item.lastProxyLatencyMs) ? escapeHtml(item.lastProxyLatencyMs + 'ms') : '-') + '</div>' + '<div class="k">连续失败</div><div class="v ' + ((item.consecutiveFailures || 0) > 0 ? 'bad' : '') + '">' + escapeHtml(item.consecutiveFailures || 0) + '</div>' + '<div class="k">最后部署</div><div class="v">' + escapeHtml(fmtDateTime(item.lastDeployAt)) + '</div>' + '<div class="k">销毁时间</div><div class="v">' + escapeHtml(fmtDateTime(item.destroyedAt)) + '</div>' + '</div>' + '<span class="card-toggle" data-toggle-card="' + id + '">' + (state.expandedCards.has(id) ? '收起 ▴' : '展开详情 ▾') + '</span>' + '<div class="card-extra ' + (state.expandedCards.has(id) ? 'expanded' : '') + '" id="' + id + '">' + '<div class="kv">' + '<div class="k">确认来源</div><div class="v">' + escapeHtml(item.confirmationSource || '-') + '</div>' + '<div class="k">失败类型</div><div class="v">' + escapeHtml(item.failureType || '-') + '</div>' + '<div class="k">可重试</div><div class="v">' + escapeHtml(item.retryable ? '是' : '否') + '</div>' + '<div class="k">最后验证</div><div class="v">' + escapeHtml(fmtDateTime(item.lastVerifiedAt)) + '</div>' + '<div class="k">上游状态</div><div class="v">' + escapeHtml(item.lastUpstreamStatus || '-') + '</div>' + '<div class="k">上游错误</div><div class="v">' + escapeHtml(item.lastUpstreamError || '-') + '</div>' + '<div class="k">代理错误</div><div class="v">' + escapeHtml(item.lastProxyError || '-') + '</div>' + '<div class="k">阶段轨迹</div><div class="v mono">' + escapeHtml((item.deployTimeline || []).map(step => [step?.stage || '?', step?.status || step?.stageStatus || '?', step?.confirmationSource || '-'].join(':')).join(' | ') || '-') + '</div>' + '<div class="k">最近响应</div><div class="v mono">' + escapeHtml(item.responseText || '-') + '</div>' + '<div class="k">部署错误</div><div class="v">' + escapeHtml(item.lastDeployError || '-') + '</div>' + '<div class="k">健康错误</div><div class="v">' + escapeHtml(item.lastHealthError || '-') + '</div>' + '</div>' + '</div>' + actionButtons(item.accountId, item.status) + '<div class="status-line">当前状态：' + escapeHtml(item.status || '-') + '</div></div>'; }).join(''); }
    function toggleCard(id) { const el = document.getElementById(id); if (!el) return; el.classList.toggle('expanded'); if (el.classList.contains('expanded')) state.expandedCards.add(id); else state.expandedCards.delete(id); const toggle = el.previousElementSibling; if (toggle) toggle.textContent = el.classList.contains('expanded') ? '收起 ▴' : '展开详情 ▾'; }
    function renderAccounts(accounts, instances) { const body = document.getElementById('accountsBody'); if (!accounts.length) { body.innerHTML = '<tr><td colspan="9" class="empty">未找到账号配置</td></tr>'; return; } body.innerHTML = accounts.map(item => { const inst = instances ? instances[item.id] : null; const instStatus = inst ? inst.status : '-'; return '<tr>' + '<td class="mono">' + escapeHtml(item.id) + '</td>' + '<td>' + escapeHtml(item.name) + '</td>' + '<td>' + statusPill(instStatus) + '</td>' + '<td>' + escapeHtml(item.enabled ? '是' : '否') + '</td>' + '<td>' + escapeHtml(item.priority) + '</td>' + '<td>' + escapeHtml(item.weight ?? 100) + '</td>' + '<td>' + escapeHtml((item.tags || []).join(', ') || '-') + '</td>' + '<td>' + escapeHtml(item.hasCookie ? '已配置' : (item.hasCookieFile ? 'cookieFile' : '缺失')) + '</td>' + '<td><div class="action-row"><button class="btn" data-edit-account="' + escapeHtml(item.id) + '">编辑</button><button class="btn" data-delete-account="' + escapeHtml(item.id) + '">删除</button></div></td>' + '</tr>'; }).join(''); }
    function renderAudit(entries) { const body = document.getElementById('auditBody'); if (!body) return; if (!entries.length) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无审计记录</td></tr>'; return; } body.innerHTML = entries.map(e => '<tr>' + '<td class="mono" style="font-size:12px">' + escapeHtml(e.at) + '</td>' + '<td>' + escapeHtml(e.action) + '</td>' + '<td class="mono">' + escapeHtml(e.target) + '</td>' + '<td>' + escapeHtml(e.detail) + '</td>' + '<td>' + (e.ok ? '<span class="pill ok">成功</span>' : '<span class="pill bad">失败</span>') + '</td>' + '</tr>').join(''); }
    function bindTabs() { document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.panel').forEach(p => p.classList.remove('active')); tab.classList.add('active'); document.querySelector('[data-panel="' + tab.dataset.tab + '"]').classList.add('active'); state.activeTab = tab.dataset.tab; if (tab.dataset.tab === 'audit') { refreshAudit().catch(showError); } })); }
    function bindRefresh() { const select = document.getElementById('refreshMs'); const applyTimer = () => { if (state.timer) clearInterval(state.timer); const ms = Number(select.value || 0); if (ms > 0) state.timer = setInterval(() => refresh().catch(showError), ms); }; select.addEventListener('change', applyTimer); applyTimer(); document.getElementById('refreshBtn').addEventListener('click', async () => { const btn = document.getElementById('refreshBtn'); await withLoading(btn, async () => { await refresh(); showToast('已刷新'); }); }); }
    function openAccountModal(mode, initial = {}) {
      state.modalMode = mode;
      document.getElementById('accountModalTitle').textContent = mode === 'create' ? '新增账号' : '编辑账号';
      document.getElementById('accountModalSubtitle').textContent = mode === 'create'
        ? '创建新账号，保存后会写回 accounts.json 并自动重载 Manager。'
        : '编辑账号配置。若 Cookie 留空，则保持原值不变。';
      document.getElementById('accountOriginalId').value = initial.id || '';
      document.getElementById('accountIdInput').value = initial.id || '';
      document.getElementById('accountNameInput').value = initial.name || initial.id || '';
      document.getElementById('accountEnabledInput').value = initial.enabled === false ? 'false' : 'true';
      document.getElementById('accountPriorityInput').value = Number.isFinite(Number(initial.priority)) ? Number(initial.priority) : 100;
      document.getElementById('accountWeightInput').value = Number.isFinite(Number(initial.weight)) ? Math.max(0, Math.round(Number(initial.weight))) : 100;
      document.getElementById('accountTagsInput').value = Array.isArray(initial.tags) ? initial.tags.join(', ') : (initial.tags || '');
      document.getElementById('accountCookieInput').value = '';
      document.getElementById('accountMetaInput').value = initial.meta ? JSON.stringify(initial.meta, null, 2) : '';
      document.getElementById('accountCookieHint').textContent = mode === 'create'
        ? '新增账号时必须填写 Cookie。'
        : '编辑账号时可留空，表示保持原值不变；填写则会覆盖旧 Cookie。';
      document.getElementById('accountModalBackdrop').classList.add('open');
      document.getElementById('accountModalBackdrop').setAttribute('aria-hidden', 'false');
      setTimeout(() => document.getElementById('accountIdInput').focus(), 0);
    }
    function closeAccountModal() {
      document.getElementById('accountModalBackdrop').classList.remove('open');
      document.getElementById('accountModalBackdrop').setAttribute('aria-hidden', 'true');
      document.getElementById('accountForm').reset();
      document.getElementById('accountOriginalId').value = '';
    }
    function collectAccountFormPayload() {
      const metaStr = document.getElementById('accountMetaInput').value.trim();
      let meta = undefined;
      if (metaStr) {
        try { meta = JSON.parse(metaStr); } catch { meta = undefined; }
      }
      return {
        id: document.getElementById('accountIdInput').value.trim(),
        name: document.getElementById('accountNameInput').value.trim(),
        enabled: document.getElementById('accountEnabledInput').value !== 'false',
        priority: Number(document.getElementById('accountPriorityInput').value || 100),
        weight: Number(document.getElementById('accountWeightInput').value || 100),
        tags: document.getElementById('accountTagsInput').value.trim(),
        cookie: document.getElementById('accountCookieInput').value.trim(),
        meta,
      };
    }

    function showToast(msg, type = 'ok') { const c = document.getElementById('toastContainer'); const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg; c.appendChild(el); requestAnimationFrame(() => el.classList.add('show')); setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000); }
    async function withLoading(btn, fn) { if (!btn || btn.disabled) return; const orig = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(orig); try { return await fn(); } catch (error) { showError(error); throw error; } finally { btn.disabled = false; btn.textContent = orig; } }
    async function refreshAudit() { const actionFilter = document.getElementById('auditActionFilter')?.value || ''; const resultFilter = document.getElementById('auditResultFilter')?.value || ''; const params = new URLSearchParams({ limit: '100' }); if (actionFilter) params.set('action', actionFilter); if (resultFilter === 'ok') params.set('ok', 'true'); if (resultFilter === 'fail') params.set('ok', 'false'); const res = await fetch('/admin/api/audit?' + params.toString(), { cache: 'no-store' }); const data = await res.json(); renderAudit(data.entries || []); }
    function bindActions() {
      document.getElementById('copyBtn').addEventListener('click', async () => { const btn = document.getElementById('copyBtn'); await withLoading(btn, async () => { try { const text = document.getElementById('accessUrl').textContent || ''; await navigator.clipboard.writeText(text); showToast('已复制接入地址'); } catch (error) { showError(error); } }); });
      document.getElementById('newAccountBtn').addEventListener('click', () => openAccountModal('create', { enabled: true, priority: 100, weight: 100, tags: [] }));
      document.getElementById('cancelAccountBtn').addEventListener('click', () => closeAccountModal());
      document.getElementById('accountModalBackdrop').addEventListener('click', (event) => { if (event.target.id === 'accountModalBackdrop') closeAccountModal(); });
      document.getElementById('accountForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = collectAccountFormPayload();
        if (!payload.id) return showToast('账号 ID 不能为空', 'bad');
        if (!payload.name) return showToast('账号名称不能为空', 'bad');
        if (state.modalMode === 'create' && !payload.cookie) return showToast('新增账号时必须填写 Cookie', 'bad');
        const btn = document.getElementById('saveAccountBtn');
        await withLoading(btn, async () => {
          const originalId = document.getElementById('accountOriginalId').value.trim();
          const isCreate = state.modalMode === 'create';
          const url = isCreate ? '/admin/api/accounts' : ('/admin/api/accounts/' + encodeURIComponent(originalId || payload.id));
          const method = isCreate ? 'POST' : 'PUT';
          const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          const text = await res.text();
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
          if (!res.ok) throw new Error(data?.message || ('HTTP ' + res.status));
          closeAccountModal();
          showToast(data.message || (isCreate ? '账号已创建' : '账号已更新'));
          await refresh();
        });
      });
      document.getElementById('startManagerBtn').addEventListener('click', async () => { const btn = document.getElementById('startManagerBtn'); await withLoading(btn, async () => { const res = await postJson('/admin/api/control/start'); showToast(res.message || 'Manager 已启动'); await refresh(); }); });
      document.getElementById('restartManagerBtn').addEventListener('click', async () => { const btn = document.getElementById('restartManagerBtn'); await withLoading(btn, async () => { const res = await postJson('/admin/api/control/restart'); showToast(res.message || 'Manager 已重启'); await refresh(); }); });
      document.getElementById('stopManagerBtn').addEventListener('click', async () => { const btn = document.getElementById('stopManagerBtn'); await withLoading(btn, async () => { const res = await postJson('/admin/api/control/stop'); showToast(res.message || 'Manager 已停止'); await refresh(); }); });
      document.body.addEventListener('click', async (event) => { const toggle = event.target.closest('[data-toggle-card]'); if (!toggle) return; toggleCard(toggle.dataset.toggleCard); });
      document.body.addEventListener('click', async (event) => { const button = event.target.closest('button[data-action]'); if (!button) return; const action = button.dataset.action; const account = button.dataset.account; if (!account || !action) return; if (!confirm('确认对 ' + account + ' 执行 ' + action + '？')) return; await withLoading(button, async () => { const res = await postJson('/admin/api/accounts/' + encodeURIComponent(account) + '/' + action); showToast(res.ok ? ('执行成功：' + account + ' / ' + action) : (res.message || '执行失败'), res.ok ? 'ok' : 'bad'); await refresh(); }); });
      document.body.addEventListener('click', async (event) => { const button = event.target.closest('button[data-edit-account]'); if (!button) return; const accountId = button.dataset.editAccount; const account = state.accounts.find(item => item.id === accountId); if (!account) return showToast('未找到账号 ' + accountId, 'bad'); openAccountModal('edit', account); });
      document.body.addEventListener('click', async (event) => { const button = event.target.closest('button[data-delete-account]'); if (!button) return; const account = button.dataset.deleteAccount; if (!account || !confirm('确认删除账号 ' + account + '？此操作会写回 accounts.json 并重载 Manager。')) return; await withLoading(button, async () => { const res = await fetch('/admin/api/accounts/' + encodeURIComponent(account), { method: 'DELETE' }); const text = await res.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; } if (!res.ok) throw new Error(data?.message || ('HTTP ' + res.status)); showToast(data.message || '账号已删除'); await refresh(); }); });
      document.getElementById('refreshAuditBtn').addEventListener('click', async () => { const btn = document.getElementById('refreshAuditBtn'); await withLoading(btn, async () => { await refreshAudit(); showToast('审计日志已刷新'); }); });
      document.getElementById('instanceStatusFilter').addEventListener('change', () => applyInstanceFilter());
      document.getElementById('accountEnabledFilter').addEventListener('change', () => { const filter = document.getElementById('accountEnabledFilter')?.value || ''; const instances = window.__lastInstances || {}; if (filter === 'enabled') { renderAccounts(state.accounts.filter(a => a.enabled), instances); } else if (filter === 'disabled') { renderAccounts(state.accounts.filter(a => !a.enabled), instances); } else { renderAccounts(state.accounts, instances); } });
      document.getElementById('auditActionFilter').addEventListener('change', () => refreshAudit().catch(showError));
      document.getElementById('auditResultFilter').addEventListener('change', () => refreshAudit().catch(showError));
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAccountModal(); });
    }
    function showError(error) { console.error(error); showToast(error?.message || String(error), 'bad'); }
    bindTabs(); bindRefresh(); bindActions(); refresh().catch(showError);
  </script>
</body>
</html>`;
}
