# Hyperledger Fabric 测试网络

## 📋 简介

这是一个 Hyperledger Fabric 区块链测试网络，包含：
- 2个组织 (Org1, Org2)
- 1个排序节点 (Orderer)
- 1个通道 (mychannel)
- 1个简单的键值存储智能合约

## 🚀 快速开始

### 一键部署

使用自动化脚本部署整个网络：

```bash
./deploy.sh
```

这个脚本会自动完成以下所有步骤：
1. ✓ 清理现有容器和网络
2. ✓ 创建组织和生成证书
3. ✓ 生成通道配置文件
4. ✓ 启动区块链网络节点
5. ✓ 节点加入通道
6. ✓ 设置锚节点
7. ✓ 部署智能合约
8. ✓ 测试智能合约调用

### 仅清理环境

如果只想清理容器和生成的文件：

```bash
./deploy.sh clean
```

## 📝 手动部署步骤

如果需要逐步手动部署：

```bash
# 1. 创建组织
./createOrgs.sh

# 2. 生成通道配置
./generateChannelArtifacts.sh

# 3. 启动网络
docker-compose up -d

# 4. 加入通道
./joinChannel.sh

# 5. 设置锚节点
./setAnchorPeer.sh

# 6. 部署智能合约
./deployChaincode.sh

# 7. 测试智能合约
./invokeChaincode.sh
```

## 🛠️ 常用命令

### 查看容器状态
```bash
docker ps
```

### 查看容器日志
```bash
# 查看 Orderer 日志
docker logs -f orderer.example.com

# 查看 Peer 日志
docker logs -f peer0.org1.example.com
docker logs -f peer0.org2.example.com
```

### 停止网络
```bash
docker-compose down
```

### 完全清理
```bash
docker-compose down --volumes
./deploy.sh clean
```

## 📦 智能合约操作

当前部署的是一个简单的键值存储合约，提供两个方法：

### Set 方法（存储数据）
```bash
peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem \
    -C mychannel \
    -n simple \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    -c '{"function":"Set","Args":["key1","value1"]}'
```

### Get 方法（查询数据）
```bash
peer chaincode query \
    -C mychannel \
    -n simple \
    -c '{"Args":["Get","key1"]}'
```

## 🏗️ 网络架构

```
┌─────────────────────────────────────────────┐
│          Orderer (example.com)              │
│         orderer.example.com:7050            │
└─────────────────────────────────────────────┘
                    │
       ┌────────────┴─────────────┐
       │                          │
┌──────▼──────┐          ┌────────▼────────┐
│   Org1MSP   │          │    Org2MSP      │
│             │          │                 │
│  Peer0      │◄────────►│  Peer0          │
│  :7051      │  Channel │  :9051          │
└─────────────┘ mychannel└─────────────────┘
```

## ⚙️ 系统要求

- Docker >= 20.10
- Docker Compose >= 1.29
- Hyperledger Fabric 二进制文件 (peer, orderer, configtxgen 等)
- Go >= 1.20 (用于开发智能合约)

## 🔍 故障排除

### 端口被占用
如果遇到端口冲突，请修改 `docker-compose.yaml` 中的端口映射。

### 容器无法启动
```bash
# 查看详细日志
docker-compose logs

# 清理后重新部署
./deploy.sh clean
./deploy.sh
```

### 链码部署失败
```bash
# 检查链码容器日志
docker logs $(docker ps -q -f name=dev-peer)
```

## 📚 更多资源

- [Hyperledger Fabric 官方文档](https://hyperledger-fabric.readthedocs.io/)
- [智能合约开发指南](https://hyperledger-fabric.readthedocs.io/en/latest/chaincode.html)
- [Fabric Samples](https://github.com/hyperledger/fabric-samples)

## 📄 许可证

Apache License 2.0
