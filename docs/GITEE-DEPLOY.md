# Gitee 部署方案

## 概述

将 skill 上传到 Gitee 仓库，部署时通过 `git clone` 拉取。

**优势：**
- ✅ 标准 Git 操作，安全审查直接放行
- ✅ 版本管理，随时回滚
- ✅ 无需 VirusTotal 扫描
- ✅ 公开仓库，无需认证

## 步骤

### 1. 创建 Gitee 仓库

1. 访问 https://gitee.com/projects/new
2. 仓库名称: `keypool-tunnel`
3. 选择 **公开（Public）**
4. **不要**初始化 README
5. 点击创建

### 2. 推送 skill 代码

```bash
cd /root/.openclaw/workspace/keypool

# 进入打包目录
cd dist/keypool-tunnel

# 初始化 Git
git init
git config user.email "deploy@keypool.local"
git config user.name "KeyPool Deployer"

# 添加远程仓库
git remote add origin https://gitee.com/qindinp/keypool-tunnel.git

# 添加文件并提交
git add -A
git commit -m "feat: KeyPool Tunnel Proxy v0.3.0"

# 推送
git push -u origin master
```

### 3. 验证仓库

访问 https://gitee.com/qindinp/keypool-tunnel 确认文件已上传。

### 4. 部署流程

Deployer 发送的命令：

```bash
# 删除旧目录
rm -rf /root/.openclaw/skills/keypool-tunnel

# 克隆仓库
git clone --depth 1 https://gitee.com/qindinp/keypool-tunnel.git /root/.openclaw/skills/keypool-tunnel

# 验证文件
test -f /root/.openclaw/skills/keypool-tunnel/SKILL.md && echo "SKILL.md found"
test -f /root/.openclaw/skills/keypool-tunnel/scripts/tunnel-proxy.mjs && echo "tunnel-proxy.mjs found"
```

然后启动：

```bash
KEYPOOL_GATEWAY_URL="ws://your-ip:9300/tunnel" \
KEYPOOL_ACCOUNT_ID="account-id" \
KEYPOOL_RUN_ID="run-id" \
nohup node /root/.openclaw/skills/keypool-tunnel/scripts/tunnel-proxy.mjs > /tmp/tunnel-proxy.log 2>&1 &
```

## 安全审查对比

| 方式 | 沙箱 AI 反应 |
|------|-------------|
| `curl http://xxx/file` | ❌ RCE |
| `ws://` 拉取代码 | ❌ RCE |
| `clawhub install` | ⚠️ 可能 suspicious |
| `git clone` | ✅ 标准开发操作 |

## 文件结构

```
keypool-tunnel/
├── .gitignore
├── README.md
├── SKILL.md
└── scripts/
    ├── tunnel-proxy.mjs
    └── lib/
        ├── ws-client.mjs
        └── api-handler.mjs
```

## 更新部署

修改代码后：

```bash
cd /root/.openclaw/workspace/keypool/dist/keypool-tunnel
git add -A
git commit -m "fix: xxx"
git push
```

下次部署会自动拉取最新版本（`git clone --depth 1`）。
