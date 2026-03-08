#!/usr/bin/env bash

set -e

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
BIN_DIR="${ROOTDIR}/../bin"
export PATH="${BIN_DIR}:${PATH}"
export FABRIC_CFG_PATH="${ROOTDIR}/configtx"
ARTIFACTS_DIR="${ROOTDIR}/channel-artifacts"

# Training Channel (Org1 and Org2 only)
TRAINING_CHANNEL="trainingchannel"
TRAINING_PROFILE="TrainingChannel"

# Inference Channel (Org1, Org2, and TP)
INFERENCE_CHANNEL="inferencechannel"
INFERENCE_PROFILE="InferenceChannel"

mkdir -p "${ARTIFACTS_DIR}"

# Generate Training Channel block
configtxgen -profile "${TRAINING_PROFILE}" -channelID "${TRAINING_CHANNEL}" -outputBlock "${ARTIFACTS_DIR}/${TRAINING_CHANNEL}.block"
echo "Channel block ${TRAINING_CHANNEL}.block generated successfully"

# Generate Inference Channel block
configtxgen -profile "${INFERENCE_PROFILE}" -channelID "${INFERENCE_CHANNEL}" -outputBlock "${ARTIFACTS_DIR}/${INFERENCE_CHANNEL}.block"
echo "Channel block ${INFERENCE_CHANNEL}.block generated successfully"
