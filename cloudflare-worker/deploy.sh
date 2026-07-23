#!/bin/bash

# Cloudflare Workers 快速部署脚本
# 使用方法: bash deploy.sh

set -e

echo "=== Seahi Serial 错误收集服务部署 ==="
echo ""

# 检查 wrangler 是否安装
if ! command -v wrangler &> /dev/null; then
    echo "正在安装 Wrangler CLI..."
    npm install -g wrangler
fi

# 检查是否已登录
echo "检查 Cloudflare 登录状态..."
if ! wrangler whoami &> /dev/null; then
    echo "请先登录 Cloudflare..."
    wrangler login
fi

# 创建 D1 数据库
echo ""
echo "创建 D1 数据库..."
DB_OUTPUT=$(wrangler d1 create seahi-errors 2>&1)
echo "$DB_OUTPUT"

# 提取 database_id
DATABASE_ID=$(echo "$DB_OUTPUT" | grep -oP 'database_id = "\K[^"]+')

if [ -z "$DATABASE_ID" ]; then
    echo "错误：无法获取 database_id"
    echo "请手动更新 wrangler.toml 中的 database_id"
    exit 1
fi

echo ""
echo "数据库 ID: $DATABASE_ID"

# 更新 wrangler.toml
echo "更新 wrangler.toml..."
sed -i "s/YOUR_DATABASE_ID/$DATABASE_ID/g" wrangler.toml

# 初始化数据库
echo ""
echo "初始化数据库..."
wrangler d1 execute seahi-errors --file=./schema.sql

# 部署 Worker
echo ""
echo "部署 Worker..."
wrangler deploy

echo ""
echo "=== 部署完成 ==="
echo ""
echo "你的 Worker URL 会在上面的输出中显示"
echo "格式类似: https://seahi-error-server.your-subdomain.workers.dev"
echo ""
echo "下一步："
echo "1. 复制 Worker URL"
echo "2. 设置环境变量: set ERROR_SERVER_URL=<你的Worker URL>"
echo "3. 构建应用: cargo build --release"
