#!/bin/bash

# Hyperledger Fabric 网络自动化部署脚本
# 功能：从零开始部署整个区块链网络并测试智能合约
# 用法: ./deploy.sh

set -e

ROOTDIR=$(cd "$(dirname "$0")" && pwd)
export PATH=${ROOTDIR}/../bin:$PATH
export FABRIC_CFG_PATH=${ROOTDIR}

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_step() {
    echo -e "${BLUE}=========================================="
    echo -e "步骤: $1"
    echo -e "==========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

# 错误处理
handle_error() {
    print_error "部署失败! 错误发生在: $1"
    print_warning "正在清理环境..."
    cleanup
    exit 1
}

# 清理函数
cleanup() {
    print_step "清理 Docker 容器和网络"
    
    # 停止所有容器
    if [ "$(docker ps -q)" ]; then
        echo "停止运行中的容器..."
        docker-compose -f ${ROOTDIR}/docker-compose.yaml down 2>/dev/null || true
    fi
    
    # 删除相关容器
    echo "删除 Fabric 相关容器..."
    docker rm -f $(docker ps -aq -f name=peer0.org1.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=peer1.org1.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=peer0.org2.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=peer1.org2.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=peer2.org2.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=peer0.tp.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=orderer.example.com) 2>/dev/null || true
    docker rm -f $(docker ps -aq -f name=dev-) 2>/dev/null || true
    
    # 删除网络
    echo "删除 Docker 网络..."
    docker network rm fabric_test 2>/dev/null || true
    
    # 删除 volumes
    echo "删除 Docker volumes..."
    docker volume rm $(docker volume ls -q -f name=orderer.example.com) 2>/dev/null || true
    docker volume rm $(docker volume ls -q -f name=peer0.org1.example.com) 2>/dev/null || true
    docker volume rm $(docker volume ls -q -f name=peer1.org1.example.com) 2>/dev/null || true
    docker volume rm $(docker volume ls -q -f name=peer0.org2.example.com) 2>/dev/null || true
    docker volume rm $(docker volume ls -q -f name=peer1.org2.example.com) 2>/dev/null || true
    docker volume rm $(docker volume ls -q -f name=peer2.org2.example.com) 2>/dev/null || true
    docker volume rm $(docker volume ls -q -f name=peer0.tp.example.com) 2>/dev/null || true
    
    # 清理生成的文件
    echo "清理生成的证书和配置文件..."
    rm -rf ${ROOTDIR}/organizations/ordererOrganizations 2>/dev/null || true
    rm -rf ${ROOTDIR}/organizations/peerOrganizations 2>/dev/null || true
    rm -rf ${ROOTDIR}/channel-artifacts/*.block 2>/dev/null || true
    rm -rf ${ROOTDIR}/channel-artifacts/*.tx 2>/dev/null || true
    rm -f ${ROOTDIR}/*.tgz 2>/dev/null || true
    
    print_success "清理完成"
}

# 等待服务启动
wait_for_service() {
    local service=$1
    local port=$2
    local max_retry=30
    local count=0
    
    echo -n "等待 $service 启动..."
    while [ $count -lt $max_retry ]; do
        if nc -z localhost $port 2>/dev/null; then
            echo ""
            print_success "$service 已就绪"
            return 0
        fi
        echo -n "."
        sleep 1
        count=$((count + 1))
    done
    
    echo ""
    print_error "$service 启动超时"
    return 1
}

# 主部署流程
main() {
    echo -e "${GREEN}"
    echo "╔════════════════════════════════════════════╗"
    echo "║   Hyperledger Fabric 网络自动化部署工具   ║"
    echo "╚════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    # 步骤 0: 清理现有环境
    print_step "0/8 - 清理现有环境"
    cleanup || handle_error "清理环境"
    sleep 2
    
    # 步骤 1: 创建组织和证书
    print_step "1/8 - 创建组织和生成证书"
    if [ -f "${ROOTDIR}/scripts/createOrgs.sh" ]; then
        chmod +x ${ROOTDIR}/scripts/createOrgs.sh
        ${ROOTDIR}/scripts/createOrgs.sh || handle_error "创建组织"
        print_success "组织证书创建成功"
    else
        print_error "scripts/createOrgs.sh 脚本不存在"
        exit 1
    fi
    
    # 步骤 2: 生成通道配置文件
    print_step "2/8 - 生成通道配置文件"
    if [ -f "${ROOTDIR}/scripts/generateChannelArtifacts.sh" ]; then
        chmod +x ${ROOTDIR}/scripts/generateChannelArtifacts.sh
        ${ROOTDIR}/scripts/generateChannelArtifacts.sh || handle_error "生成通道配置"
        print_success "通道配置文件生成成功"
    else
        print_error "scripts/generateChannelArtifacts.sh 脚本不存在"
        exit 1
    fi
    
    # 步骤 3: 启动 Docker 网络
    print_step "3/8 - 启动区块链网络节点"
    docker-compose -f ${ROOTDIR}/docker-compose.yaml up -d || handle_error "启动 Docker 网络"
    print_success "Docker 容器启动成功"
    
    # 等待节点启动
    echo ""
    wait_for_service "Orderer" 7050 || handle_error "Orderer 启动"
    wait_for_service "Peer0.Org1" 7051 || handle_error "Peer0.Org1 启动"
    wait_for_service "Peer0.Org2" 9051 || handle_error "Peer0.Org2 启动"
    
    echo ""
    print_success "所有节点已启动并就绪"
    sleep 3
    
    # 步骤 4: 节点加入通道
    print_step "4/8 - 节点加入通道"
    if [ -f "${ROOTDIR}/scripts/joinChannel.sh" ]; then
        chmod +x ${ROOTDIR}/scripts/joinChannel.sh
        ${ROOTDIR}/scripts/joinChannel.sh || handle_error "节点加入通道"
        print_success "节点成功加入两个通道"
    else
        print_error "scripts/joinChannel.sh 脚本不存在"
        handle_error "脚本缺失"
    fi
    
    # 步骤 5: 设置锚节点 (为两个 channel 分别设置)
    print_step "5/8 - 设置锚节点"
    if [ -f "${ROOTDIR}/scripts/setAnchorPeer.sh" ]; then
        chmod +x ${ROOTDIR}/scripts/setAnchorPeer.sh
        echo "为 Training Channel 设置锚节点..."
        ${ROOTDIR}/scripts/setAnchorPeer.sh 1 trainingchannel || handle_error "设置 Org1@Training 锚节点"
        ${ROOTDIR}/scripts/setAnchorPeer.sh 2 trainingchannel || handle_error "设置 Org2@Training 锚节点"
        print_success "Training Channel 锚节点设置成功"
        
        echo "为 Inference Channel 设置锚节点..."
        ${ROOTDIR}/scripts/setAnchorPeer.sh 1 inferencechannel || handle_error "设置 Org1@Inference 锚节点"
        ${ROOTDIR}/scripts/setAnchorPeer.sh 2 inferencechannel || handle_error "设置 Org2@Inference 锚节点"
        ${ROOTDIR}/scripts/setAnchorPeer.sh 3 inferencechannel || handle_error "设置 TP@Inference 锚节点"
        print_success "Inference Channel 锚节点设置成功"
    else
        print_error "scripts/setAnchorPeer.sh 脚本不存在"
        handle_error "脚本缺失"
    fi
    
    # 步骤 6: 部署智能合约
    print_step "6/8 - 部署智能合约"
    if [ -f "${ROOTDIR}/scripts/deployChaincode.sh" ]; then
        chmod +x ${ROOTDIR}/scripts/deployChaincode.sh
        ${ROOTDIR}/scripts/deployChaincode.sh || handle_error "部署智能合约"
        print_success "智能合约在两个通道部署成功"
    else
        print_error "scripts/deployChaincode.sh 脚本不存在"
        handle_error "脚本缺失"
    fi
    
    # 等待链码容器启动
    echo ""
    echo -n "等待链码容器初始化..."
    sleep 5
    echo ""
    print_success "链码容器已就绪"
    
    # 步骤 7: 测试智能合约
    print_step "7/8 - 测试智能合约调用"
    if [ -f "${ROOTDIR}/scripts/invokeChaincode.sh" ]; then
        chmod +x ${ROOTDIR}/scripts/invokeChaincode.sh
        ${ROOTDIR}/scripts/invokeChaincode.sh || handle_error "测试智能合约"
        print_success "智能合约测试成功"
    else
        print_warning "scripts/invokeChaincode.sh 脚本不存在，跳过测试"
    fi
    
    # 步骤 8: 显示网络状态
    print_step "8/8 - 网络部署完成"
    echo ""
    echo -e "${GREEN}┌─────────────────────────────────────────────┐${NC}"
    echo -e "${GREEN}│        🎉 网络部署成功！                    │${NC}"
    echo -e "${GREEN}└─────────────────────────────────────────────┘${NC}"
    echo ""
    echo "通道配置:"
    echo "  - Training Channel: Org1 (2 peers) + Org2 (3 peers)"
    echo "  - Inference Channel: Org1 (2 peers) + Org2 (3 peers) + TP (1 peer)"
    echo ""
    echo "网络信息："
    echo "  • 组织数量: 2 (Org1, Org2)"
    echo "  • 排序节点: orderer.example.com:7050"
    echo "  • Org1 节点: peer0.org1.example.com:7051"
    echo "  • Org2 节点: peer0.org2.example.com:9051"
    echo "  • 通道名称: mychannel"
    echo "  • 智能合约: simple"
    echo ""
    echo "运行中的容器："
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" --filter "name=peer0.org1.example.com" --filter "name=peer0.org2.example.com" --filter "name=orderer.example.com"
    echo ""
    echo -e "${YELLOW}常用命令:${NC}"
    echo "  • 查看日志: docker logs -f <container_name>"
    echo "  • 停止网络: docker-compose down"
    echo "  • 重新部署: ./deploy.sh"
    echo "  • 仅清理环境: ./deploy.sh clean"
    echo ""
}

# 检查参数
if [ "$1" = "clean" ] || [ "$1" = "cleanup" ]; then
    cleanup
    print_success "环境清理完成"
    exit 0
fi

# 检查依赖
if ! command -v docker &> /dev/null; then
    print_error "Docker 未安装，请先安装 Docker"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose 未安装，请先安装 Docker Compose"
    exit 1
fi

if ! command -v nc &> /dev/null; then
    print_warning "netcat (nc) 未安装，将跳过端口检查"
fi

# 执行主流程
main

exit 0
