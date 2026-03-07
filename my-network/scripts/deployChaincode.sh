#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
export PATH="${ROOTDIR}/../bin:${PATH}"
export FABRIC_CFG_PATH="${ROOTDIR}"

CC_NAME="simple"
CC_SRC_PATH="${ROOTDIR}/chaincode"
CC_VERSION="1.0"
CHANNEL_NAME="mychannel"

ORDERER_CA="${ROOTDIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"
ORG1_TLS="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
ORG2_TLS="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt"

# Auto-detect current sequence number
detectSequence() {
  export CORE_PEER_LOCALMSPID="Org1MSP"
  export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:7051"
  export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
  export CORE_PEER_TLS_ENABLED="true"
  
  local committed=$(peer lifecycle chaincode querycommitted --channelID ${CHANNEL_NAME} --name ${CC_NAME} 2>&1 | grep -oP 'Sequence: \K[0-9]+' || echo "0")
  echo $((committed + 1))
}

CC_SEQUENCE=$(detectSequence)

echo "=========================================="
echo "Deploying Chaincode: ${CC_NAME}"
echo "Version: ${CC_VERSION}"
echo "Channel: ${CHANNEL_NAME}"
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

# Step 3: Install on Org1
echo ""
echo "▶ Step 3: Installing on Org1 peer0..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode install ${CC_NAME}_${CC_VERSION}.tgz || echo "⚠ Chaincode already installed on Org1 (skipping)"
echo "✓ Org1 ready"

# Step 4: Install on Org2
echo ""
echo "▶ Step 4: Installing on Org2 peer0..."
export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
export CORE_PEER_ADDRESS="localhost:9051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG2_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode install ${CC_NAME}_${CC_VERSION}.tgz || echo "⚠ Chaincode already installed on Org2 (skipping)"
echo "✓ Org2 ready"

# Step 5: Approve for Org1
echo ""
echo "▶ Step 5: Approving chaincode definition for Org1..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${CHANNEL_NAME} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com
echo "✓ Approved for Org1"

# Step 6: Approve for Org2
echo ""
echo "▶ Step 6: Approving chaincode definition for Org2..."
export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
export CORE_PEER_ADDRESS="localhost:9051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG2_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode approveformyorg \
  --channelID ${CHANNEL_NAME} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --package-id ${PACKAGE_ID} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com
echo "✓ Approved for Org2"

# Step 7: Commit chaincode definition
echo ""
echo "▶ Step 7: Committing chaincode definition..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${ROOTDIR}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${ORG1_TLS}"
export CORE_PEER_TLS_ENABLED="true"

peer lifecycle chaincode commit \
  --channelID ${CHANNEL_NAME} \
  --name ${CC_NAME} \
  --version ${CC_VERSION} \
  --sequence ${CC_SEQUENCE} \
  --tls \
  --cafile ${ORDERER_CA} \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --peerAddresses localhost:7051 --tlsRootCertFiles ${ORG1_TLS} \
  --peerAddresses localhost:9051 --tlsRootCertFiles ${ORG2_TLS}
echo "✓ Chaincode definition committed"

# Step 8: Verify deployment
echo ""
echo "▶ Step 8: Verifying chaincode deployment..."
peer lifecycle chaincode querycommitted \
  --channelID ${CHANNEL_NAME} \
  --name ${CC_NAME}
echo "✓ Chaincode successfully deployed!"

echo ""
echo "=========================================="
echo "✓ Deployment Complete"
echo "=========================================="
echo ""
echo "Now you can invoke the chaincode:"
echo "  peer chaincode invoke -C ${CHANNEL_NAME} -n ${CC_NAME} ..."
