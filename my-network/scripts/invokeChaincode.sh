#!/bin/bash

# 链码调用测试脚本
# 用法: ./invokeChaincode.sh

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
export PATH=${ROOTDIR}/../bin:$PATH
export FABRIC_CFG_PATH=${ROOTDIR}

CHANNEL_NAME="mychannel"
CC_NAME="simple"
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

echo "=========================================="
echo "测试链码调用 - Set 操作"
echo "=========================================="

setOrg1Env

echo ""
echo "1. 设置 name = Alice"
peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile ${ORDERER_CA} \
    -C ${CHANNEL_NAME} \
    -n ${CC_NAME} \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    --peerAddresses localhost:9051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
    -c '{"function":"Set","Args":["name","Alice"]}'

sleep 3

echo ""
echo "2. 查询 name"
peer chaincode query \
    -C ${CHANNEL_NAME} \
    -n ${CC_NAME} \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    -c '{"function":"Get","Args":["name"]}'

echo ""
echo ""
echo "=========================================="
echo "3. 设置 age = 25"
peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile ${ORDERER_CA} \
    -C ${CHANNEL_NAME} \
    -n ${CC_NAME} \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
    --peerAddresses localhost:9051 \
    --tlsRootCertFiles ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
    -c '{"function":"Set","Args":["age","25"]}'

sleep 2

echo ""
echo "4. 查询 age"
peer chaincode query \
    -C ${CHANNEL_NAME} \
    -n ${CC_NAME} \
    -c '{"function":"Get","Args":["age"]}'

echo ""
echo ""
echo "=========================================="
echo "切换到 Org2 进行查询测试"
echo "=========================================="

setOrg2Env

echo ""
echo "5. 从 Org2 查询 name"
peer chaincode query \
    -C ${CHANNEL_NAME} \
    -n ${CC_NAME} \
    -c '{"function":"Get","Args":["name"]}'

echo ""
echo "6. 从 Org2 查询 age"
peer chaincode query \
    -C ${CHANNEL_NAME} \
    -n ${CC_NAME} \
    -c '{"function":"Get","Args":["age"]}'

echo ""
echo "=========================================="
echo "✓ 链码测试完成"
echo "=========================================="
