# Node.js Fabric Client

轻量级 Hyperledger Fabric 客户端，使用官方 `fabric-network` SDK。

## 🚀 快速开始

### 1️⃣ 安装依赖

```bash
cd nodejs-client
npm install
```

### 2️⃣ 确保网络已运行

从项目根目录运行：

```bash
cd ..
./deploy.sh
```

### 3️⃣ 使用 CLI

#### 存储键值

```bash
node src/cli.js set name Alice
# 或使用 npm script
npm run set name Alice
```

#### 查询键值

```bash
node src/cli.js get name
# 或
npm run get name
```

#### 查看帮助

```bash
node src/cli.js --help
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
| `FABRIC_CHAINCODE` | `simple` | 链码名称 |
| `FABRIC_MSP_ID` | `Org1MSP` | 组织 MSP ID |
| `FABRIC_PEER_ENDPOINT` | `localhost:7051` | Peer 地址 |
| `FABRIC_ORDERER_ENDPOINT` | `localhost:7050` | Orderer 地址 |

使用 `.env` 文件覆盖：

```bash
# .env
FABRIC_CHANNEL=mychannel
FABRIC_CHAINCODE=simple
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
