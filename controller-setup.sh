#!/bin/bash
# KeyPool Controller (Part 2) — 外部持久服务器一键部署
#
# 用法:
#   curl -sL https://raw.githubusercontent.com/qindinp/keypool/main/controller-setup.sh | bash
#   或手动: bash controller-setup.sh "serviceToken=xxx; userId=xxx"

set -e

echo "╔══════════════════════════════════════════════════╗"
echo "║  KeyPool Controller (Part 2) 安装                ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 需要 Node.js 18+，请先安装"
    exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "❌ Node.js 版本过低 ($(node -v))，需要 18+"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# 安装目录
INSTALL_DIR="${CONTROLLER_DIR:-$HOME/keypool-controller}"

if [ -d "$INSTALL_DIR/.git" ]; then
    echo "📂 更新已有安装..."
    cd "$INSTALL_DIR" && git pull
else
    echo "📂 克隆项目..."
    git clone https://github.com/qindinp/keypool.git "$INSTALL_DIR/keypool-src"
    mkdir -p "$INSTALL_DIR"
    cp "$INSTALL_DIR/keypool-src/controller.mjs" "$INSTALL_DIR/"
    cp "$INSTALL_DIR/keypool-src/controller-setup.sh" "$INSTALL_DIR/" 2>/dev/null || true
    rm -rf "$INSTALL_DIR/keypool-src"
    cd "$INSTALL_DIR"
fi

# Cookie 设置
COOKIE_FILE="$INSTALL_DIR/.cookie"
if [ -n "$1" ]; then
    echo "$1" > "$COOKIE_FILE"
    echo "✅ Cookie 已保存到 $COOKIE_FILE"
elif [ -n "$MIMO_COOKIE" ]; then
    echo "$MIMO_COOKIE" > "$COOKIE_FILE"
    echo "✅ Cookie (从环境变量) 已保存到 $COOKIE_FILE"
elif [ ! -f "$COOKIE_FILE" ]; then
    echo ""
    echo "⚠️  请设置 Cookie:"
    echo "  方式1: bash controller-setup.sh 'serviceToken=xxx; userId=xxx'"
    echo "  方式2: echo 'serviceToken=xxx; userId=xxx' > $COOKIE_FILE"
    echo "  方式3: export MIMO_COOKIE='serviceToken=xxx; userId=xxx'"
    echo ""
    echo "Cookie 获取方法:"
    echo "  1. 打开 https://aistudio.xiaomimimo.com"
    echo "  2. 登录后，F12 → Application → Cookies"
    echo "  3. 复制 serviceToken 和 userId 的值"
    echo ""
    exit 1
fi

# 创建启动脚本
cat > "$INSTALL_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
cd "$(dirname "$0")"
export MIMO_COOKIE="$(cat .cookie)"
exec node controller.mjs "$@"
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"

# 创建 systemd 服务 (可选)
if command -v systemctl &> /dev/null && [ "$(id -u)" = "0" ]; then
    cat > /etc/systemd/system/keypool-controller.service << SVCEOF
[Unit]
Description=KeyPool Controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/controller.mjs
EnvironmentFile=$INSTALL_DIR/.cookie.env
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
SVCEOF

    # 创建 env 文件
    cat > "$INSTALL_DIR/.cookie.env" << ENVEOF
MIMO_COOKIE=$(cat "$COOKIE_FILE")
ENVEOF

    systemctl daemon-reload
    echo ""
    echo "✅ systemd 服务已创建"
    echo "   启动: systemctl start keypool-controller"
    echo "   自启: systemctl enable keypool-controller"
    echo "   日志: journalctl -u keypool-controller -f"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ 安装完成                                      ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║                                                    ║"
echo "║  启动方式:                                         ║"
echo "║    cd $INSTALL_DIR"
echo "║    ./start.sh                # 前台运行            ║"
echo "║    ./start.sh --once         # 单次检查            ║"
echo "║    ./start.sh --status       # 查看状态            ║"
echo "║    ./start.sh --deploy       # 强制重新部署        ║"
echo "║                                                    ║"
echo "║  systemd:                                          ║"
echo "║    systemctl start keypool-controller              ║"
echo "║    systemctl enable keypool-controller             ║"
echo "║                                                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
