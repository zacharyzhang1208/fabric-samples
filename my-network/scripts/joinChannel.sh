#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
BIN_DIR="${ROOTDIR}/../bin"
export PATH="${BIN_DIR}:${PATH}"

CHANNEL_NAME="mychannel"
ORDERER_CA="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
ORDERER_CERT="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt"
ORDERER_KEY="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.key"

# Orderer joins channel (skip if already present)
if ! osnadmin channel list -o localhost:7053 --ca-file "$ORDERER_CA" --client-cert "$ORDERER_CERT" --client-key "$ORDERER_KEY" | grep -q "\"name\": \"${CHANNEL_NAME}\""; then
  osnadmin channel join \
    --channelID ${CHANNEL_NAME} \
    --config-block ${ROOTDIR}/channel-artifacts/${CHANNEL_NAME}.block \
    -o localhost:7053 \
    --ca-file "$ORDERER_CA" \
    --client-cert "$ORDERER_CERT" \
    --client-key "$ORDERER_KEY"
fi

# Copy orderer TLS CA into peers for validation
docker cp "$ORDERER_CA" peer0.org1.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer1.org1.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer0.org2.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer1.org2.example.com:/tmp/orderer-ca.crt
docker cp "$ORDERER_CA" peer2.org2.example.com:/tmp/orderer-ca.crt

# Copy Admin MSP into peers to satisfy Admins policy during join
docker cp ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp peer0.org1.example.com:/tmp/org1-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp peer1.org1.example.com:/tmp/org1-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp peer0.org2.example.com:/tmp/org2-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp peer1.org2.example.com:/tmp/org2-admin-msp
docker cp ${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp peer2.org2.example.com:/tmp/org2-admin-msp

# Wait for orderer to be ready (raft leader election + deliver service)
echo "Waiting for orderer to be ready..."
ORDERER_READY=false
for i in {1..30}; do
  if docker exec -e CORE_PEER_LOCALMSPID=Org1MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org1-admin-msp \
    -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
    peer0.org1.example.com \
    peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt 2>/dev/null; then
    ORDERER_READY=true
    echo "✓ Orderer is ready"
    break
  fi
  echo "  Attempt $i/30: Orderer not ready yet, retrying in 1s..."
  sleep 1
done

if [ "$ORDERER_READY" = false ]; then
  echo "✗ Orderer failed to become ready after 30 seconds"
  exit 1
fi

# Peer0.Org1 joins
docker exec -e CORE_PEER_LOCALMSPID=Org1MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org1-admin-msp \
  -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
  peer0.org1.example.com sh -c \
  "peer channel list | grep -q ${CHANNEL_NAME} || ( \
     peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt && \
     peer channel join -b /tmp/${CHANNEL_NAME}.block \
   )"

# Peer1.Org1 joins
docker exec -e CORE_PEER_LOCALMSPID=Org1MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org1-admin-msp \
  -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
  peer1.org1.example.com sh -c \
  "peer channel list | grep -q ${CHANNEL_NAME} || ( \
     peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt && \
     peer channel join -b /tmp/${CHANNEL_NAME}.block \
   )"

# Peer0.Org2 joins
docker exec -e CORE_PEER_LOCALMSPID=Org2MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org2-admin-msp \
  -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
  peer0.org2.example.com sh -c \
  "peer channel list | grep -q ${CHANNEL_NAME} || ( \
     peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt && \
     peer channel join -b /tmp/${CHANNEL_NAME}.block \
   )"

# Peer1.Org2 joins
docker exec -e CORE_PEER_LOCALMSPID=Org2MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org2-admin-msp \
  -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
  peer1.org2.example.com sh -c \
  "peer channel list | grep -q ${CHANNEL_NAME} || ( \
     peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt && \
     peer channel join -b /tmp/${CHANNEL_NAME}.block \
   )"

# Peer2.Org2 joins
docker exec -e CORE_PEER_LOCALMSPID=Org2MSP -e CORE_PEER_MSPCONFIGPATH=/tmp/org2-admin-msp \
  -e CORE_PEER_TLS_ENABLED=true -e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt \
  peer2.org2.example.com sh -c \
  "peer channel list | grep -q ${CHANNEL_NAME} || ( \
     peer channel fetch 0 /tmp/${CHANNEL_NAME}.block -o orderer.example.com:7050 -c ${CHANNEL_NAME} --tls --cafile /tmp/orderer-ca.crt && \
     peer channel join -b /tmp/${CHANNEL_NAME}.block \
   )"

echo "Channel ${CHANNEL_NAME} peers successfully joined"
echo "To set anchor peers, run: ./setAnchorPeer.sh org1 ${CHANNEL_NAME}"
echo "                          ./setAnchorPeer.sh org2 ${CHANNEL_NAME}"
