#!/bin/bash
# KeyPool 一键启动脚本
# 用法: curl -sL https://raw.githubusercontent.com/qindinp/keypool/main/setup.sh | bash

set -e

echo "🚀 KeyPool 一键部署中..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "📦 安装 Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>/dev/null
    apt-get install -y nodejs 2>/dev/null || {
        echo "⚠️  apt 安装失败，尝试使用 nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install 22
    }
fi

echo "✅ Node.js $(node -v)"

# 克隆或更新
INSTALL_DIR="$HOME/keypool"
if [ -d "$INSTALL_DIR" ]; then
    echo "📂 更新已有安装..."
    cd "$INSTALL_DIR" && git pull
else
    echo "📂 克隆项目..."
    git clone https://github.com/qindinp/keypool.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 启动
echo ""
echo "🚀 启动 KeyPool..."
echo "================================"
node server.mjs
