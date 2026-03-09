# Node.js Fabric Client - Decentralized FL Architecture

轻量级 Hyperledger Fabric 客户端 + 去中心化联邦学习模拟。

**架构特点**：
- ✅ **无中央协调器**：5 个独立 FL 客户端进程
- ✅ **模拟真实部署**：每个客户端 = 一个组织的一个节点
- ✅ **Hyperledger 集成**：客户端可独立提交/查询链上聚合结果
- ✅ **容错设计**：单个节点故障不影响其他节点

## 🚀 快速开始

### 1️⃣ 安装依赖

```bash
cd nodejs-client
npm install
```

### 2️⃣ 启动 Fabric 网络

```bash
cd ..
./deploy.sh
```

### 3️⃣ 启动 5 个独立 FL 客户端

```bash
cd nodejs-client
node src/launchClients.js <rounds> <epochs>
```

例如，运行 3 轮，每轮 5 个 epoch：
```bash
node src/launchClients.js 3 5
```

**拓扑**：
- Bank A: 2 个节点（端口 3001, 3002）
- Bank B: 3 个节点（端口 3003, 3004, 3005）

### 4️⃣ CLI 操作（基础 Fabric 交互）

#### 存储键值
```bash
node src/cli.js set key value
```

#### 查询键值
```bash
node src/cli.js get key
```

#### 查看帮助
```bash
node src/cli.js --help
```

## 📋 工作流程

### 单个 FL 客户端生命周期

```
flClient.js (--org A --node 1 --port 3001)
│
├─ 1. 初始化
│  ├─ 连接到 Fabric 网络（使用 Org1 Admin 身份）
│  ├─ 生成本地数据集（client-specific drift）
│  └─ 构建本地 TensorFlow.js 模型
│
├─ 2. 多轮循环
│  ├─ [Round 1]
│  │  ├─ 本地训练（3-5 epochs）
│  │  ├─ 提交更新到链：`fl:update:1:A:1 = {weight, bias, sampleCount}`
│  │  ├─ 等待聚合完成（轮询）
│  │  └─ 查询全球模型：`fl:global:1`（如果存在）
│  │
│  └─ [Round 2, 3, ...]
│
└─ 3. 清理
   ├─ 释放 TensorFlow 模型
   ├─ 关闭 Fabric 连接
   └─ 退出
```

### 链上数据结构

每个 FL 客户端向链上写入：

```json
{
  "fl:update:1:A:1": {
    "round": 1,
    "org": "A",
    "node": 1,
    "weight": 1.788,
    "bias": -0.037,
    "sampleCount": 20,
    "timestamp": "2026-03-07T13:10:52.523Z"
  }
}
```

## 背书节点与 Fabric Discovery 机制

### 关键发现

当前架构中，**只有 2 个 peer 安装了链码**：
- `peer0.org1.example.com:7051`（Org1 背书节点）
- `peer0.org2.example.com:9051`（Org2 背书节点）

而 FL 客户端拓扑有 5 个节点：
- A-N1 → peer0.org1 ✓ 背书节点
- A-N2 → peer1.org1 ✗ 无链码
- B-N1 → peer0.org2 ✓ 背书节点
- B-N2 → peer1.org2 ✗ 无链码
- B-N3 → peer2.org2 ✗ 无链码

**但所有客户端都成功提交了交易！原因是什么？**

### Discovery 机制（fabric-network SDK）

在 `flClient.js` 中：
```javascript
discovery: { enabled: true, asLocalhost: true }
```

当 Discovery 启用时，fabric-network SDK 会：

1. **建立连接**：客户端连接到指定 peer（比如 peer1.org1:7151）
2. **查询背书者**：SDK 向该 peer 查询"哪些 peer 有链码"
3. **自动路由**：SDK 自动发现背书节点是 peer0.org1:7051
4. **重新路由**：SDK 自动将交易路由到有背书资格的 peer
5. **返回结果**：背书完成后返回给客户端

### 实际的交易流程

```
A-N2 (连接到 peer1.org1:7151)
  ↓ Discovery query: "谁有链码？"
  ↓ 发现：peer0.org1.example.com 有链码
  ↓ 自动路由到 peer0.org1.example.com:7051
  ↓ 背书成功
  ✓ 交易提交
```

### 优势

- ✅ **透明**：客户端无需知道谁是背书节点
- ✅ **灵活**：新增背书节点时自动发现
- ✅ **可靠**：如果主背书节点故障，SDK 会尝试其他节点
- ✅ **符合标准**：这是 Hyperledger Fabric 的推荐实践

### 验证证据

运行以下命令查看实际链码部署情况：
```bash
# 只有这两个容器
docker ps | grep dev-

# 输出：
# dev-peer0.org1.example.com-simple_1.0-...
# dev-peer0.org2.example.com-simple_1.0-...
```

## �🔄 未来：聚合服务

目前客户端查询 `fl:global:<round>` 时会找不到（因为没有外部聚合服务）。

后续添加聚合服务（可选择以下方案）：
- **Option A**：独立聚合进程
- **Option B**：链码内聚合逻辑
- **Option C**：特定时间点触发聚合

## 🛠️ 文件说明

| 文件 | 功能 |
|------|------|
| `flClient.js` | 单个独立 FL 客户端程序 |
| `launchClients.js` | 启动所有 5 个客户端的管理器 |
| `cli.js` | 基础 Fabric 交互 CLI（set/get） |
| `fabricClient.js` | Fabric SDK 封装 |
| `config.js` | 环境配置 |

### 运行 FL 模拟

```bash
node src/cli.js fl:run
# 或
npm run fl
```

### 常用参数

```bash
node src/cli.js fl:run --rounds 8 --clients 5 --samples 30 --localEpochs 4 --lr 0.02

# 可调 batch size
node src/cli.js fl:run --batchSize 16
```

输出会展示每一轮的全局参数和 MSE，例如：

```bash
Round 1: w=..., b=..., mse=...
Round 2: w=..., b=..., mse=...
```

运行时会显示：`Mode: multi-process (coordinator + client workers)`。

### 生成可视化图表

默认会生成 HTML 报告（含 MSE/Weight/Bias 曲线）：

```bash
node src/cli.js fl:run
# 输出: Chart report generated: .../reports/fl-report.html
```

自定义图表输出路径：

```bash
node src/cli.js fl:run --chartFile ./reports/my-fl.html
```

禁用图表生成：

```bash
node src/cli.js fl:run --no-chart
```

## 📁 项目结构

```
nodejs-client/
├── package.json          # 项目依赖
├── src/
│   ├── cli.js           # 命令行入口
│   ├── config.js        # 网络配置
│   └── fabricClient.js  # Fabric SDK 封装
└── README.md
```

## 🔧 配置

默认配置（可通过环境变量覆盖）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FABRIC_CHANNEL` | `mychannel` | 通道名称 |
| `FABRIC_CHAINCODE` | `contracts` | 链码名称 |
| `FABRIC_MSP_ID` | `Org1MSP` | 组织 MSP ID |
| `FABRIC_PEER_ENDPOINT` | `localhost:7051` | Peer 地址 |
| `FABRIC_ORDERER_ENDPOINT` | `localhost:7050` | Orderer 地址 |

使用 `.env` 文件覆盖：

```bash
# .env
FABRIC_CHANNEL=mychannel
FABRIC_CHAINCODE=contracts
```

## 🎯 API 示例

### 编程方式调用

```javascript
const FabricClient = require('./src/fabricClient');

async function example() {
  const client = new FabricClient();
  
  try {
    await client.connect();
    
    // 存储
    await client.set('name', 'Alice');
    
    // 查询
    const value = await client.get('name');
    console.log(value); // Alice
    
  } finally {
    await client.disconnect();
  }
}

example().catch(console.error);
```

## 🤖 扩展：机器学习集成

### 推荐库

1. **TensorFlow.js**
   ```bash
   npm install @tensorflow/tfjs-node
   ```

2. **Brain.js**（神经网络）
   ```bash
   npm install brain.js
   ```

3. **ML.js**（通用机器学习）
   ```bash
   npm install ml
   ```

### 示例：链码 + ML

```javascript
const FabricClient = require('./fabricClient');
const tf = require('@tensorflow/tfjs-node');

// 从链上读取训练数据
async function getTrainingData() {
  const client = new FabricClient();
  await client.connect();
  const data = await client.get('ml_dataset');
  await client.disconnect();
  return JSON.parse(data);
}

// 保存模型预测到链上
async function savePrediction(key, prediction) {
  const client = new FabricClient();
  await client.connect();
  await client.set(key, JSON.stringify(prediction));
  await client.disconnect();
}
```

## 🐛 故障排除

### 连接失败

确保网络已运行：
```bash
cd .. && ./deploy.sh
```

### 权限错误

检查证书路径是否正确：
```bash
ls -la ../organizations/peerOrganizations/org1.example.com/users/
```

### 端口占用

确认端口配置与 docker-compose.yaml 一致。

## 📚 更多资源

- [Fabric Network SDK](https://hyperledger.github.io/fabric-sdk-node/)
- [TensorFlow.js](https://www.tensorflow.org/js)
- [Hyperledger Fabric 文档](https://hyperledger-fabric.readthedocs.io/)
