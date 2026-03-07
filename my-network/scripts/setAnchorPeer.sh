#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
BIN_DIR="${ROOTDIR}/../bin"
export PATH="${BIN_DIR}:${PATH}"
export FABRIC_CFG_PATH="${ROOTDIR}"

ORG=$1
CHANNEL=$2

if [ -z "$ORG" ] || [ -z "$CHANNEL" ]; then
  echo "Usage: $0 <org_num> <channel_name>"
  echo "Example: $0 1 mychannel"
  exit 1
fi

# Set peer and orderer environment
case $ORG in
  1)
    export CORE_PEER_LOCALMSPID=Org1MSP
    export CORE_PEER_MSPCONFIGPATH=${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
    export CORE_PEER_ADDRESS=peer0.org1.example.com:7051
    HOST="peer0.org1.example.com"
    PORT=7051
    ;;
  2)
    export CORE_PEER_LOCALMSPID=Org2MSP
    export CORE_PEER_MSPCONFIGPATH=${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp
    export CORE_PEER_ADDRESS=peer0.org2.example.com:9051
    HOST="peer0.org2.example.com"
    PORT=9051
    ;;
  *)
    echo "Invalid org: $ORG"
    exit 1
    ;;
esac

export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_TLS_ROOTCERT_FILE=${ROOTDIR}/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt
export ORDERER_CA=${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt

# Determine peer container name
case $ORG in
  1)
    PEER_CONTAINER="peer0.org1.example.com"
    ;;
  2)
    PEER_CONTAINER="peer0.org2.example.com"
    ;;
esac

echo "Setting anchor peer for Org$ORG on channel $CHANNEL..."

# Copy orderer CA
cp "$ORDERER_CA" /tmp/orderer-ca.crt

# Fetch channel config (direct peer command on host)
${BIN_DIR}/peer channel fetch config ${ROOTDIR}/channel-artifacts/config_block.pb \
  -o localhost:7050 -c $CHANNEL --tls --cafile /tmp/orderer-ca.crt

# Decode and extract config (on host)
${BIN_DIR}/configtxlator proto_decode --input ${ROOTDIR}/channel-artifacts/config_block.pb --type common.Block --output /tmp/config_block.json
jq '.data.data[0].payload.data.config' /tmp/config_block.json > /tmp/config.json

# If the same anchor peer already exists, skip update
if jq -e \
  ".channel_group.groups.Application.groups.Org${ORG}MSP.values.AnchorPeers.value.anchor_peers[] | select(.host==\"${HOST}\" and .port==${PORT})" \
  /tmp/config.json > /dev/null 2>&1; then
  echo "Anchor peer already set for Org${ORG} on channel ${CHANNEL}. Skipping."
  exit 0
fi

# Modify config: add anchor peer (host)
jq ".channel_group.groups.Application.groups.Org${ORG}MSP.values += {\"AnchorPeers\": {\"mod_policy\": \"Admins\", \"value\": {\"anchor_peers\": [{\"host\": \"${HOST}\", \"port\": ${PORT}}]}, \"version\": \"0\"}}" \
  /tmp/config.json > /tmp/modified_config.json

# Compute config update (host)
${BIN_DIR}/configtxlator proto_encode --input /tmp/config.json --type common.Config --output /tmp/config.pb
${BIN_DIR}/configtxlator proto_encode --input /tmp/modified_config.json --type common.Config --output /tmp/modified_config.pb
if ! ${BIN_DIR}/configtxlator compute_update --channel_id $CHANNEL --original /tmp/config.pb --updated /tmp/modified_config.pb --output /tmp/config_update.pb; then
  echo "No config differences detected. Anchor update not required."
  exit 0
fi

# Wrap update in envelope (host)
${BIN_DIR}/configtxlator proto_decode --input /tmp/config_update.pb --type common.ConfigUpdate --output /tmp/config_update.json
echo "{\"payload\":{\"header\":{\"channel_header\":{\"channel_id\":\"${CHANNEL}\",\"type\":3}},\"data\":{\"config_update\":$(cat /tmp/config_update.json)}}}" > /tmp/config_update_envelope.json
${BIN_DIR}/configtxlator proto_encode --input /tmp/config_update_envelope.json --type common.Envelope --output /tmp/anchor_update.tx

# Submit anchor update (direct peer command on host)
${BIN_DIR}/peer channel update -o localhost:7050 -c $CHANNEL -f ${ROOTDIR}/channel-artifacts/anchor_update.tx --tls --cafile /tmp/orderer-ca.crt

echo "✓ Anchor peer set for Org$ORG on channel $CHANNEL"
