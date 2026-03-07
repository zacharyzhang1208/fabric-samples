#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
BIN_DIR="${ROOTDIR}/../bin"
export PATH="${BIN_DIR}:${PATH}"
export FABRIC_CFG_PATH="${ROOTDIR}/configtx"
ARTIFACTS_DIR="${ROOTDIR}/channel-artifacts"

CHANNEL_NAME="mychannel"
PROFILE="TwoOrgsApplicationGenesis"

mkdir -p "${ARTIFACTS_DIR}"

configtxgen -profile "${PROFILE}" -channelID "${CHANNEL_NAME}" -outputBlock "${ARTIFACTS_DIR}/${CHANNEL_NAME}.block"
echo "Channel block ${CHANNEL_NAME}.block generated successfully"
