#!/bin/bash
# 初始化 Gitee 仓库并推送 skill 代码
# 用法: ./scripts/init-gitee.sh [gitee-username]

set -e

GITEE_USER="${1:-qindinp}"
REPO_NAME="keypool-tunnel"
REPO_URL="https://gitee.com/${GITEE_USER}/${REPO_NAME}.git"
DIST_DIR="dist/keypool-tunnel"

echo "📦 准备推送 skill 到 Gitee..."
echo "   仓库: ${REPO_URL}"
echo ""

# 检查 dist 目录
if [ ! -d "${DIST_DIR}" ]; then
    echo "❌ 错误: ${DIST_DIR} 不存在，请先运行打包"
    exit 1
fi

# 进入 dist 目录
cd "${DIST_DIR}"

# 初始化 git（如果还没有）
if [ ! -d ".git" ]; then
    echo "🔧 初始化 Git 仓库..."
    git init
    git config user.email "deploy@keypool.local"
    git config user.name "KeyPool Deployer"
fi

# 添加远程仓库
echo "🔗 设置远程仓库..."
git remote remove origin 2>/dev/null || true
git remote add origin "${REPO_URL}"

# 添加所有文件
echo "📁 添加文件..."
git add -A

# 提交
echo "💾 提交代码..."
git commit -m "feat: KeyPool Tunnel Proxy v0.3.0" || echo "没有新的更改"

# 推送
echo "🚀 推送到 Gitee..."
echo ""
echo "⚠️  首次推送需要在 Gitee 上创建仓库："
echo "   1. 访问 https://gitee.com/projects/new"
echo "   2. 仓库名称: ${REPO_NAME}"
echo "   3. 选择公开（Public）"
echo "   4. 不要初始化 README"
echo "   5. 点击创建"
echo ""
echo "然后执行："
echo "   git push -u origin master"
echo ""
echo "或者如果仓库已存在："
echo "   git push -u origin main --force"
