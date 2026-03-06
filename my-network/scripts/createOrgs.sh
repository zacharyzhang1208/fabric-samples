#!/usr/bin/env bash

set -e

# Directories
ROOTDIR=$(cd "$(dirname "$0")" && pwd)
BIN_DIR="${ROOTDIR}/../bin"
export PATH="${BIN_DIR}:${PATH}"
CRYPTO_CONFIG_DIR="${ROOTDIR}/crypto-config"
OUTPUT_DIR="${ROOTDIR}/organizations"

# Check cryptogen exists
if ! command -v cryptogen &> /dev/null; then
  echo "Error: cryptogen not found"
  exit 1
fi

# Clean up existing
if [ -d "${OUTPUT_DIR}" ]; then
  rm -rf "${OUTPUT_DIR}"
fi

# Create output directory
mkdir -p "${OUTPUT_DIR}"

# Generate crypto material
echo "Generating crypto material..."
cryptogen generate --config="${CRYPTO_CONFIG_DIR}/crypto-config.yaml" --output="${OUTPUT_DIR}"

# Copy admin certs to msp/admincerts for Peer organizations
echo "Setting up admin certificates..."

# For Org1
if [ -d "${OUTPUT_DIR}/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/" ]; then
  mkdir -p "${OUTPUT_DIR}/peerOrganizations/org1.example.com/msp/admincerts"
  cp "${OUTPUT_DIR}"/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/*.pem \
     "${OUTPUT_DIR}/peerOrganizations/org1.example.com/msp/admincerts/" 2>/dev/null || true
fi

# For Org2
if [ -d "${OUTPUT_DIR}/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp/signcerts/" ]; then
  mkdir -p "${OUTPUT_DIR}/peerOrganizations/org2.example.com/msp/admincerts"
  cp "${OUTPUT_DIR}"/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp/signcerts/*.pem \
     "${OUTPUT_DIR}/peerOrganizations/org2.example.com/msp/admincerts/" 2>/dev/null || true
fi

# Copy admin certs to msp/admincerts for Orderer organization
if [ -d "${OUTPUT_DIR}/ordererOrganizations/example.com/users/Admin@example.com/msp/signcerts/" ]; then
  mkdir -p "${OUTPUT_DIR}/ordererOrganizations/example.com/msp/admincerts"
  cp "${OUTPUT_DIR}"/ordererOrganizations/example.com/users/Admin@example.com/msp/signcerts/*.pem \
     "${OUTPUT_DIR}/ordererOrganizations/example.com/msp/admincerts/" 2>/dev/null || true
fi

echo "Done! Organizations created in: ${OUTPUT_DIR}"
