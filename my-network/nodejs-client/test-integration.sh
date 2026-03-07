#!/bin/bash

# 示例：自动化测试 Node.js 客户端与 Fabric 网络交互
# 用法: cd .. && ./nodejs-client/test-integration.sh

set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

echo "================================================"
echo "Node.js Fabric Client 集成测试"
echo "================================================"
echo ""

# 步骤 1: 清理并部署网络
echo "1️⃣  清理旧环境并部署 Fabric 网络..."
cd "$PROJECT_ROOT"
./deploy.sh clean
./deploy.sh

echo ""
echo "2️⃣  等待网络稳定..."
sleep 3

# 步骤 2: 测试 Node.js 客户端
echo ""
echo "3️⃣  测试 Node.js 客户端..."
cd "$SCRIPT_DIR"

echo ""
echo "  ▶ 设置 key1=value1"
node src/cli.js set key1 value1

echo ""
echo "  ▶ 查询 key1"
node src/cli.js get key1

echo ""
echo "  ▶ 设置 name=Bob"
node src/cli.js set name Bob

echo ""
echo "  ▶ 查询 name"
node src/cli.js get name

echo ""
echo "================================================"
echo "✅ 测试完成！Node.js 客户端工作正常"
echo "================================================"
