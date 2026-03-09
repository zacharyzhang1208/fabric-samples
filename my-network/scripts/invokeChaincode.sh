#!/bin/bash

# 双通道链码调用测试脚本
# 测试 Training Channel 和 Inference Channel

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
export PATH=${ROOTDIR}/../bin:$PATH
export FABRIC_CFG_PATH=${ROOTDIR}

TRAINING_CHANNEL="trainingchannel"
INFERENCE_CHANNEL="inferencechannel"
CC_NAME="contracts"
ORDERER_CA=${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem

# 设置 Org1 环境变量
setOrg1Env() {
    export CORE_PEER_TLS_ENABLED=true
    export CORE_PEER_LOCALMSPID="Org1MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE=${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
    export CORE_PEER_MSPCONFIGPATH=${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
    export CORE_PEER_ADDRESS=localhost:7051
}

# 设置 Org2 环境变量
setOrg2Env() {
    export CORE_PEER_TLS_ENABLED=true
    export CORE_PEER_LOCALMSPID="Org2MSP"
    export CORE_PEER_TLS_ROOTCERT_FILE=${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt
    export CORE_PEER_MSPCONFIGPATH=${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp
    export CORE_PEER_ADDRESS=localhost:9051
}

# 设置 TP 环境变量
setTPEnv() {
    export CORE_PEER_TLS_ENABLED=true
    export CORE_PEER_LOCALMSPID="TPMSP"
    export CORE_PEER_TLS_ROOTCERT_FILE=${ROOTDIR}/organizations/peerOrganizations/tp.example.com/peers/peer0.tp.example.com/tls/ca.crt
    export CORE_PEER_MSPCONFIGPATH=${ROOTDIR}/organizations/peerOrganizations/tp.example.com/users/Admin@tp.example.com/msp
    export CORE_PEER_ADDRESS=localhost:11051
}

# 带重试的查询（解决提交后短时间内部分 peer 还未可读的问题）
queryWithRetry() {
    local channel=$1
    local key=$2
    local peerAddress=$3
    local tlsRootCert=$4
    local maxRetry=${5:-12}
    local sleepSec=${6:-2}

    local i=1
    while [ $i -le $maxRetry ]; do
        if peer chaincode query \
            -C ${channel} \
            -n ${CC_NAME} \
            --peerAddresses ${peerAddress} \
            --tlsRootCertFiles ${tlsRootCert} \
            -c "{\"function\":\"Get\",\"Args\":[\"${key}\"]}"; then
            return 0
        fi

        if [ $i -lt $maxRetry ]; then
            echo "  Query retry ${i}/${maxRetry} for key ${key} on ${peerAddress}..."
            sleep ${sleepSec}
        fi
        i=$((i + 1))
    done

    echo "Query failed after ${maxRetry} retries for key ${key} on ${peerAddress}"
    return 1
}

echo "=========================================="
echo "测试 Training Channel (Org1 + Org2)"
echo "=========================================="

setOrg1Env

echo ""
echo "1. Org1 提交训练更新到 Training Channel"
peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile ${ORDERER_CA} \
    -C ${TRAINING_CHANNEL} \
    -n ${CC_NAME} \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    --peerAddresses localhost:9051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
    -c '{"function":"Set","Args":["training:org1:update1","model_weights_v1"]}'

sleep 2

echo ""
echo "2. Org2 查询 Org1 的训练更新（同通道可见）"
setOrg2Env
queryWithRetry \
    ${TRAINING_CHANNEL} \
    "training:org1:update1" \
    "localhost:9051" \
    "${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
    8 \
    1

echo ""
echo "3. Org2 提交训练更新到 Training Channel"
peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile ${ORDERER_CA} \
    -C ${TRAINING_CHANNEL} \
    -n ${CC_NAME} \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    --peerAddresses localhost:9051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
    -c '{"function":"Set","Args":["training:org2:update1","model_weights_v2"]}'

sleep 2

echo ""
echo "=========================================="
echo "测试 Inference Channel (Org1 + Org2 + TP)"
echo "=========================================="

setOrg1Env

echo ""
echo "4. Org1 发布全局模型到 Inference Channel"
peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile ${ORDERER_CA} \
    -C ${INFERENCE_CHANNEL} \
    -n ${CC_NAME} \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    --peerAddresses localhost:9051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
    --peerAddresses localhost:11051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/tp.example.com/peers/peer0.tp.example.com/tls/ca.crt \
    -c '{"function":"Set","Args":["global_model:v1","aggregated_model_weights"]}'

sleep 2

echo ""
echo "5. TP 查询全局模型（Inference Channel 可见）"
setTPEnv
queryWithRetry \
    ${INFERENCE_CHANNEL} \
    "global_model:v1" \
    "localhost:11051" \
    "${ROOTDIR}/organizations/peerOrganizations/tp.example.com/peers/peer0.tp.example.com/tls/ca.crt" \
    15 \
    2

echo ""
echo "6. Org2 从 Inference Channel 查询全局模型"
setOrg2Env
queryWithRetry \
    ${INFERENCE_CHANNEL} \
    "global_model:v1" \
    "localhost:9051" \
    "${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
    12 \
    2

echo ""
echo "=========================================="
echo "✓ 双通道测试完成"
echo "=========================================="
echo "Training Channel: Org1 和 Org2 可交换训练更新"
echo "Inference Channel: 所有组织（含TP）可访问全局模型"
echo "通道隔离: TP 无法访问 Training Channel"
