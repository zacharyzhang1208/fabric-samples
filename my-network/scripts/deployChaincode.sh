#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
export PATH="${ROOTDIR}/../bin:${PATH}"
export FABRIC_CFG_PATH="${ROOTDIR}"

CC_NAME="contracts"
CC_SRC_PATH="${ROOTDIR}/chaincode"
CC_VERSION="1.0"
TRAINING_CHANNEL="trainingchannel"
INFERENCE_CHANNEL="inferencechannel"
STRATEGY="default"

ORDERER_CA="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"
ORG1_TLS="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
ORG2_TLS="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt"
TP_TLS="${ROOTDIR}/organizations/peerOrganizations/tp.example.com/peers/peer0.tp.example.com/tls/ca.crt"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strategy)
      STRATEGY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--strategy vpsa|default]"
      exit 1
      ;;
  esac
done

COLLECTIONS_TRAINING_ARGS=()
COLLECTIONS_INFERENCE_ARGS=()
if [[ "${STRATEGY}" == "vpsa" ]]; then
  COLLECTIONS_TRAINING_FILE="${ROOTDIR}/pdc/collections.training.json"
  COLLECTIONS_INFERENCE_FILE="${ROOTDIR}/pdc/collections.inference.json"
  
  if [[ ! -f "${COLLECTIONS_TRAINING_FILE}" ]]; then
    echo "Missing Training PDC config: ${COLLECTIONS_TRAINING_FILE}"
    exit 1
  fi
  if [[ ! -f "${COLLECTIONS_INFERENCE_FILE}" ]]; then
    echo "Missing Inference PDC config: ${COLLECTIONS_INFERENCE_FILE}"
    exit 1
  fi
  
  COLLECTIONS_TRAINING_ARGS=(--collections-config "${COLLECTIONS_TRAINING_FILE}")
  COLLECTIONS_INFERENCE_ARGS=(--collections-config "${COLLECTIONS_INFERENCE_FILE}")
fi

# Auto-detect current sequence number for a channel
detectSequence() {
  local CHANNEL=$1
  export CORE_PEER_LOCALMSPID="Org1MSP"
  export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:7051"
  export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
  export CORE_PEER_TLS_ENABLED="true"
  
  local committed=$(peer lifecycle chaincode querycommitted --channelID ${CHANNEL} --name ${CC_NAME} 2>&1 | grep -oP 'Sequence: \K[0-9]+' || echo "0")
  echo $((committed + 1))
}

echo "=========================================="
echo "Deploying Chaincode: ${CC_NAME}"
echo "Version: ${CC_VERSION}"
echo "Strategy: ${STRATEGY}"
if [[ "${STRATEGY}" == "vpsa" ]]; then
  echo "Training PDC: ${COLLECTIONS_TRAINING_FILE}"
  echo "Inference PDC: ${COLLECTIONS_INFERENCE_FILE}"
fi
echo "=========================================="

# Step 0: Vendor Go dependencies (required for Docker deployment)
echo ""
echo "▶ Step 0: Vendoring Go dependencies..."
cd "${CC_SRC_PATH}"
GO111MODULE=on go mod vendor
echo "✓ Go dependencies vendored"

# Step 1: Package chaincode
echo ""
echo "▶ Step 1: Packaging chaincode..."
cd "${ROOTDIR}"
peer lifecycle chaincode package ${CC_NAME}_${CC_VERSION}.tgz \
  --path ${CC_SRC_PATH} \
  --lang golang \
  --label ${CC_NAME}_${CC_VERSION}
echo "✓ Chaincode packaged: ${CC_NAME}_${CC_VERSION}.tgz"

# Step 2: Calculate package ID
echo ""
echo "▶ Step 2: Calculating package ID..."
PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid ${CC_NAME}_${CC_VERSION}.tgz)
echo "✓ Package ID: ${PACKAGE_ID}"

# Step 3: Install on all peers
echo ""
echo "▶ Step 3: Installing on Org1 peer0..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"
peer lifecycle chaincode install ${CC_NAME}_${CC_VERSION}.tgz || echo "⚠ Chaincode already installed on Org1 peer0 (skipping)"

echo "▶ Installing on Org2 peer0..."
export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
export CORE_PEER_ADDRESS="localhost:9051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG2_TLS}"
export CORE_PEER_TLS_ENABLED="true"
peer lifecycle chaincode install ${CC_NAME}_${CC_VERSION}.tgz || echo "⚠ Chaincode already installed on Org2 peer0 (skipping)"

echo "▶ Installing on TP peer0..."
export CORE_PEER_LOCALMSPID="TPMSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/tp.example.com/users/Admin@tp.example.com/msp"
export CORE_PEER_ADDRESS="localhost:11051"
export CORE_PEER_TLS_ROOTCERT_FILE="${TP_TLS}"
export CORE_PEER_TLS_ENABLED="true"
peer lifecycle chaincode install ${CC_NAME}_${CC_VERSION}.tgz || echo "⚠ Chaincode already installed on TP peer0 (skipping)"

echo "✓ All peers installed"

#######################################
# Deploy on Training Channel
#######################################
echo ""
echo "=========================================="
echo "Deploying on Training Channel (Org1, Org2)"
echo "=========================================="

CC_SEQUENCE=$(detectSequence ${TRAINING_CHANNEL})

# Approve for Org1
echo ""
echo "▶ Approving for Org1..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${TRAINING_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  "${COLLECTIONS_TRAINING_ARGS[@]}" \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com
echo "✓ Approved for Org1"

# Approve for Org2
echo ""
echo "▶ Approving for Org2..."
export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
export CORE_PEER_ADDRESS="localhost:9051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG2_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${TRAINING_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  "${COLLECTIONS_TRAINING_ARGS[@]}" \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com
echo "✓ Approved for Org2"

# Commit on Training Channel
echo ""
echo "▶ Committing on Training Channel..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode commit \
  --channelID ${TRAINING_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --sequence ${CC_SEQUENCE} \
  "${COLLECTIONS_TRAINING_ARGS[@]}" \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --peerAddresses localhost:7051 --tlsRootCertFiles ${ORG1_TLS} \
  --peerAddresses localhost:9051 --tlsRootCertFiles ${ORG2_TLS}
echo "✓ Training Channel deployment complete"

#######################################
# Deploy on Inference Channel
#######################################
echo ""
echo "=========================================="
echo "Deploying on Inference Channel (Org1, Org2, TP)"
echo "=========================================="

CC_SEQUENCE=$(detectSequence ${INFERENCE_CHANNEL})

# Approve for Org1
echo ""
echo "▶ Approving for Org1..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${INFERENCE_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  "${COLLECTIONS_INFERENCE_ARGS[@]}"
echo "✓ Approved for Org1"

# Approve for Org2
echo ""
echo "▶ Approving for Org2..."
export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
export CORE_PEER_ADDRESS="localhost:9051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG2_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${INFERENCE_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  "${COLLECTIONS_INFERENCE_ARGS[@]}"
echo "✓ Approved for Org2"

# Approve for TP
echo ""
echo "▶ Approving for TP..."
export CORE_PEER_LOCALMSPID="TPMSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/tp.example.com/users/Admin@tp.example.com/msp"
export CORE_PEER_ADDRESS="localhost:11051"
export CORE_PEER_TLS_ROOTCERT_FILE="${TP_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${INFERENCE_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  "${COLLECTIONS_INFERENCE_ARGS[@]}"
echo "✓ Approved for TP"

# Commit on Inference Channel
echo ""
echo "▶ Committing on Inference Channel..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode commit \
  --channelID ${INFERENCE_CHANNEL} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --peerAddresses localhost:7051 --tlsRootCertFiles ${ORG1_TLS} \
  --peerAddresses localhost:9051 --tlsRootCertFiles ${ORG2_TLS} \
  --peerAddresses localhost:11051 --tlsRootCertFiles ${TP_TLS} \
  "${COLLECTIONS_INFERENCE_ARGS[@]}"
echo "✓ Inference Channel deployment complete"

echo ""
echo "=========================================="
echo "✓ All Deployments Complete"
echo "=========================================="
echo "Training Channel: Org1 + Org2"
echo "Inference Channel: Org1 + Org2 + TP"
if [[ "${STRATEGY}" == "vpsa" ]]; then
  echo "PDC Configuration: enabled"
  echo "  Training PDC: vpsaOrg1Shards, vpsaOrg2Shards"
  echo "  Inference PDC: inferenceTPShards, inferenceOrg1Shards, inferenceOrg2Shards"
fi
