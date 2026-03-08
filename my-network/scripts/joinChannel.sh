#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
BIN_DIR="${ROOTDIR}/../bin"
export PATH="${BIN_DIR}:${PATH}"

TRAINING_CHANNEL="trainingchannel"
INFERENCE_CHANNEL="inferencechannel"
ORDERER_CA="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
ORDERER_CERT="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt"
ORDERER_KEY="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.key"

# Function to join orderer to channel
join_orderer_to_channel() {
  local CHANNEL_NAME=$1
  if ! osnadmin channel list -o localhost:7053 --ca-file "$ORDERER_CA" --client-cert "$ORDERER_CERT" --client-key "$ORDERER_KEY" | grep -q "\"name\": \"${CHANNEL_NAME}\""; then
    osnadmin channel join \
      --channelID ${CHANNEL_NAME} \
      --config-block ${ROOTDIR}/channel-artifacts/${CHANNEL_NAME}.block \
      -o localhost:7053 \
      --ca-file "$ORDERER_CA" \
      --client-cert "$ORDERER_CERT" \
      --client-key "$ORDERER_KEY"
    echo "✓ Orderer joined ${CHANNEL_NAME}"
  fi
}

# Function to wait for orderer to be ready for a channel
wait_for_orderer() {
  local CHANNEL_NAME=$1
  echo "Waiting for orderer to be ready for ${CHANNEL_NAME}..."
  ORDERER_READY=false
  for i in {1..30}; do
    if docker exec -e CORE_PEER_LOCALMSPID=Org1MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org1-admin-msp \
      -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
      peer0.org1.example.com \
      peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt 2>/dev/null; then
      ORDERER_READY=true
      echo "✓ Orderer is ready for ${CHANNEL_NAME}"
      break
    fi
    echo "  Attempt $i/30: Orderer not ready yet, retrying in 1s..."
    sleep 1
  done
  
  if [ "$ORDERER_READY" = false ]; then
    echo "✗ Orderer failed to become ready after 30 seconds"
    exit 1
  fi
}

# Function to join peer to channel
join_peer_to_channel() {
  local PEER_NAME=$1
  local MSP_ID=$2
  local MSP_PATH=$3
  local CHANNEL_NAME=$4
  
  docker exec -e CORE_PEER_LOCALMSPID=${MSP_ID} -e CORE_PEER_MSPCONFIGPATH=${MSP_PATH} \
    -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
    ${PEER_NAME} sh -c \
    "peer channel list | grep -q ${CHANNEL_NAME} || ( \
       peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt && \
       peer channel join -b /tmp/${CHANNEL_NAME}.block \
     )"
  echo "✓ ${PEER_NAME} joined ${CHANNEL_NAME}"
}

# Copy orderer TLS CA into all peers
docker cp "$ORDERER_CA" peer0.org1.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer1.org1.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer0.org2.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer1.org2.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer2.org2.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer0.tp.example.com:/tmp/orderer-ca.crt

# Copy Admin MSP into peers
docker cp ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp peer0.org1.example.com:/tmp/org1-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp peer1.org1.example.com:/tmp/org1-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp peer0.org2.example.com:/tmp/org2-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp peer1.org2.example.com:/tmp/org2-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp peer2.org2.example.com:/tmp/org2-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/tp.example.com/users/Admin@tp.example.com/msp peer0.tp.example.com:/tmp/tp-admin-msp

echo "========================================" 
echo "Joining Training Channel (Org1, Org2)"
echo "========================================"

# Orderer joins Training Channel
join_orderer_to_channel ${TRAINING_CHANNEL}
wait_for_orderer ${TRAINING_CHANNEL}

# All Org1 and Org2 peers join Training Channel
join_peer_to_channel "peer0.org1.example.com" "Org1MSP" "/tmp/org1-admin-msp" ${TRAINING_CHANNEL}
join_peer_to_channel "peer1.org1.example.com" "Org1MSP" "/tmp/org1-admin-msp" ${TRAINING_CHANNEL}
join_peer_to_channel "peer0.org2.example.com" "Org2MSP" "/tmp/org2-admin-msp" ${TRAINING_CHANNEL}
join_peer_to_channel "peer1.org2.example.com" "Org2MSP" "/tmp/org2-admin-msp" ${TRAINING_CHANNEL}
join_peer_to_channel "peer2.org2.example.com" "Org2MSP" "/tmp/org2-admin-msp" ${TRAINING_CHANNEL}

echo ""
echo "========================================" 
echo "Joining Inference Channel (Org1, Org2, TP)"
echo "========================================"

# Orderer joins Inference Channel
join_orderer_to_channel ${INFERENCE_CHANNEL}
wait_for_orderer ${INFERENCE_CHANNEL}

# All Org1, Org2, and TP peers join Inference Channel
join_peer_to_channel "peer0.org1.example.com" "Org1MSP" "/tmp/org1-admin-msp" ${INFERENCE_CHANNEL}
join_peer_to_channel "peer1.org1.example.com" "Org1MSP" "/tmp/org1-admin-msp" ${INFERENCE_CHANNEL}
join_peer_to_channel "peer0.org2.example.com" "Org2MSP" "/tmp/org2-admin-msp" ${INFERENCE_CHANNEL}
join_peer_to_channel "peer1.org2.example.com" "Org2MSP" "/tmp/org2-admin-msp" ${INFERENCE_CHANNEL}
join_peer_to_channel "peer2.org2.example.com" "Org2MSP" "/tmp/org2-admin-msp" ${INFERENCE_CHANNEL}
join_peer_to_channel "peer0.tp.example.com" "TPMSP" "/tmp/tp-admin-msp" ${INFERENCE_CHANNEL}

echo ""
echo "========================================" 
echo "✓ All peers joined both channels"
echo "========================================"
echo "Training Channel: Org1 (2 peers) + Org2 (3 peers)"
echo "Inference Channel: Org1 (2 peers) + Org2 (3 peers) + TP (1 peer)"
