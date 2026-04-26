#!/usr/bin/env node

/**
 * Independent FL Client for Multi-Organization Fabric Network
 * Each instance represents a peer node in a specific organization
 */

require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Suppress TensorFlow C++ INFO logs (oneDNN/CPU feature banners).
if (!process.env.TF_CPP_MIN_LOG_LEVEL) {
  process.env.TF_CPP_MIN_LOG_LEVEL = '2';
}

const tf = require('@tensorflow/tfjs-node');
const path = require('path');
const fs = require('fs');
const FabricClient = require('./fabricClient');
const { writeJson } = require('./utils/timing');

class FlClient {
  constructor(options) {
    this.org = options.org;
    this.nodeId = options.node;
    this.port = options.port;
    this.clientId = `${this.org}-N${this.nodeId}`;
    
    // Organization parameters
    this.orgDomain = options.orgDomain;
    this.orgMspId = options.orgMspId;
    this.peerName = options.peerName;
    this.peerEndpoint = options.peerEndpoint;
    this.ordererEndpoint = options.ordererEndpoint || 'localhost:7050';
    this.projectRoot = options.projectRoot;
    this.org1NodeCount = options.org1NodeCount || 2;
    this.org2NodeCount = options.org2NodeCount || 3;
    this.dataset = options.dataset || 'linear';
    this.mnistSamples = options.mnistSamples || 20000;
    this.resume = Boolean(options.resume);

    const legacyMode = options.mode ? String(options.mode).toLowerCase() : null;
    this.topology = String(options.topology || 'decentralized').toLowerCase();
    this.syncMode = String(options.syncMode || 'sync').toLowerCase();

    if (legacyMode) {
      if (legacyMode === 'centralized') {
        this.topology = 'centralized';
        this.syncMode = 'sync';
      } else if (legacyMode === 'decentralized' || legacyMode === 'sync') {
        this.topology = 'decentralized';
        this.syncMode = 'sync';
      } else if (legacyMode === 'async') {
        this.topology = 'decentralized';
        this.syncMode = 'async';
      }
    }

    const validTopologies = new Set(['centralized', 'decentralized']);
    if (!validTopologies.has(this.topology)) {
      throw new Error(`Unsupported topology: ${this.topology}. Use centralized or decentralized.`);
    }
    const validSyncModes = new Set(['sync', 'async']);
    if (!validSyncModes.has(this.syncMode)) {
      throw new Error(`Unsupported syncMode: ${this.syncMode}. Use sync or async.`);
    }

    this.mode = this.syncMode === 'async'
      ? 'async'
      : (this.topology === 'centralized' ? 'centralized' : 'decentralized');
    
    this.fabricClientOptions = {
      orgDomain: this.orgDomain,
      orgMspId: this.orgMspId,
      peerName: this.peerName,
      peerEndpoint: this.peerEndpoint,
      ordererEndpoint: this.ordererEndpoint,
      projectRoot: this.projectRoot,
      peerHostAlias: this.peerName,
      ordererHostAlias: 'orderer.example.com',
      channelName: 'trainingchannel',
      chaincodeName: 'contracts',
    };
    
    this.fabricClient = null;
    this.model = null;
    this.localData = null;
    this.dataLoader = null;
    
    // Async mode specific fields
    this.currentBaselineVersion = 0;  // Track which global model version we're based on
    this.latestAvailableVersion = 0; // Latest version fetched from chain
    this.asyncStepCount = 0;          // Steps taken in async mode (not round-based)
    this.asyncBatchSize = 5;
    this.asyncPendingTimeoutMs = 15000;
    this.asyncCommitteeTakeoverMs = 2500;
    this.centralizedCoordinatorId = process.env.CENTRALIZED_COORDINATOR || 'A-N1';
    this.isCentralizedCoordinator = this.topology === 'centralized' && this.clientId === this.centralizedCoordinatorId;
    this.asyncCommitteeMembers = this.buildAsyncCommitteeMembers();
    this.asyncCommitteeRank = this.asyncCommitteeMembers.indexOf(this.clientId);
    this.isAsyncCommitteeMember = this.syncMode === 'async' && this.asyncCommitteeRank >= 0;
    this.isAsyncCommitteeLeader = this.isAsyncCommitteeMember && this.asyncCommitteeRank === 0;
    this.submitOrderIndex =
      this.orgMspId === 'Org1MSP'
        ? Math.max(0, this.nodeId - 1)
        : Math.max(0, this.org1NodeCount + this.nodeId - 1);
    this.asyncAggregationLoopActive = false;
    this.asyncAggregationLoopPromise = null;
    const adhocRunId = `adhoc-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.runId = process.env.FL_TIMING_RUN_ID || adhocRunId;
    this.timingRoot = process.env.FL_TIMING_ROOT || path.join(this.projectRoot, 'nodejs-client', 'reports', 'timing', this.runId);
    this.timingFilePath = path.join(this.timingRoot, 'clients', `${this.clientId}.json`);
    this.lastSubmissionTiming = null;
    this.lastAggregationTiming = null;
    this.coordinatorRoundInitNotified = new Set();
    this.coordinatorRoundInitWaiters = new Map();
    this.coordinatorIpcEnabled = typeof process.send === 'function';
    this.timing = {
      runId: this.runId,
      clientId: this.clientId,
      dataset: this.dataset,
      mode: this.mode,
      topology: this.topology,
      syncMode: this.syncMode,
      org: this.org,
      nodeId: this.nodeId,
      orgMspId: this.orgMspId,
      peerName: this.peerName,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      status: 'running',
      initialization: {},
      training: {},
      rounds: [],
    };

    this.setupCoordinatorSignals();
  }

  setupCoordinatorSignals() {
    process.on('message', (message) => {
      if (!message || message.type !== 'coordinator-round-initialized') {
        return;
      }

      const round = Number(message.round);
      if (!Number.isInteger(round) || round <= 0) {
        return;
      }

      this.coordinatorRoundInitNotified.add(round);
      const waiters = this.coordinatorRoundInitWaiters.get(round);
      if (waiters && waiters.length > 0) {
        waiters.forEach((resolve) => resolve(true));
        this.coordinatorRoundInitWaiters.delete(round);
      }
    });
  }

  notifyCoordinatorRoundInitialized(round) {
    if (!this.coordinatorIpcEnabled) {
      return;
    }

    try {
      process.send({
        type: 'coordinator-round-initialized',
        round,
        coordinator: this.clientId,
      });
    } catch (err) {
      console.warn(`[${this.clientId}] Failed to publish coordinator round init signal: ${this.getErrMessage(err)}`);
    }
  }

  waitForCoordinatorRoundInitialized(round, timeoutMs = 15000) {
    if (this.coordinatorRoundInitNotified.has(round)) {
      return Promise.resolve(true);
    }

    if (!this.coordinatorIpcEnabled) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = this.coordinatorRoundInitWaiters.get(round) || [];
        const nextWaiters = waiters.filter((fn) => fn !== resolver);
        if (nextWaiters.length > 0) {
          this.coordinatorRoundInitWaiters.set(round, nextWaiters);
        } else {
          this.coordinatorRoundInitWaiters.delete(round);
        }
        resolve(false);
      }, timeoutMs);

      const resolver = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };

      const waiters = this.coordinatorRoundInitWaiters.get(round) || [];
      waiters.push(resolver);
      this.coordinatorRoundInitWaiters.set(round, waiters);
    });
  }

  async waitForCentralizedRoundInitialized(round) {
    const notified = await this.waitForCoordinatorRoundInitialized(round, 15000);
    if (notified) {
      return;
    }

    await this.waitForContractSignal(
      `CentralizedRoundInitialized(${round})`,
      () => this.fabricClient.getRoundStatus(round),
      (status) => status && Number.isInteger(status.expectedCount) && status.expectedCount > 0,
      { attempts: 30, intervalMs: 500, reconnectOnConnectionError: false }
    );
  }

  writeTimingSnapshot() {
    this.timing.updatedAt = new Date().toISOString();
    writeJson(this.timingFilePath, this.timing);
  }

  finalizeTiming(status, extra = {}) {
    this.timing.status = status;
    this.timing.endedAt = new Date().toISOString();
    this.timing.endedAtMs = Date.now();
    this.timing.totalMs = this.timing.endedAtMs - this.timing.startedAtMs;
    Object.assign(this.timing, extra);
    this.writeTimingSnapshot();
  }

  async initialize() {
    console.log(`[${this.clientId}] Initializing... (${this.orgDomain}/${this.peerName})`);
    console.log(`[${this.clientId}] Using dataset: ${this.dataset}`);
    let phaseStart = Date.now();
    await this.setupFabricClient();
    this.timing.initialization.fabricConnectMs = Date.now() - phaseStart;

    phaseStart = Date.now();
    await this.generateLocalDataset();
    this.timing.initialization.loadDatasetMs = Date.now() - phaseStart;

    phaseStart = Date.now();
    this.buildModel();
    this.timing.initialization.buildModelMs = Date.now() - phaseStart;
    this.writeTimingSnapshot();
  }

  async setupFabricClient() {
    this.fabricClient = new FabricClient(this.fabricClientOptions);
    try {
      await this.fabricClient.connect();
      await this.verifyFabricReady();
      console.log(`[${this.clientId}] Connected to Fabric (${this.peerName})`);
      if (this.isAsyncCommitteeMember) {
        await this.startAsyncCommitteeFlow();
      }
    } catch (err) {
      console.error(`[${this.clientId}] Failed to connect to Fabric:`, err.message);
      throw err;
    }
  }

  async generateLocalDataset() {
    const globalNodeIndex =
      this.orgMspId === 'Org1MSP'
        ? this.nodeId - 1
        : this.org1NodeCount + this.nodeId - 1;

    const { DataLoaderFactory } = require('./dataLoaders');
    this.dataLoader = DataLoaderFactory.create(this.dataset, this.clientId, {
      trainSamples: this.mnistSamples,
      totalNodes: this.org1NodeCount + this.org2NodeCount,
      nodeIndex: globalNodeIndex,
    });
    
    if (this.dataset === 'linear') {
      this.localData = await this.dataLoader.load();
      console.log(`[${this.clientId}] Generated local dataset: ${this.localData.sampleCount} samples`);
    } else if (this.dataset === 'mnist') {
      this.localData = await this.dataLoader.load();
      console.log(`[${this.clientId}] Loaded MNIST dataset: ${this.localData.sampleCount} samples`);
    } else if (this.dataset === 'cifar') {
      this.localData = await this.dataLoader.load();
      console.log(`[${this.clientId}] Loaded CIFAR-10 dataset: ${this.localData.sampleCount} samples`);
    } else {
      throw new Error(`Unknown dataset: ${this.dataset}`);
    }
  }

  buildModel() {
    this.model = this.dataLoader.buildModel();
    console.log(`[${this.clientId}] Model initialized (${this.dataset})`);
  }

  getExecutionModeGroup() {
    return this.syncMode;
  }

  getTopologyGroup() {
    return this.topology;
  }

  getModelStorageDir() {
    return path.join(
      this.projectRoot,
      'nodejs-client',
      'models',
      this.dataset,
      this.getExecutionModeGroup(),
      this.getTopologyGroup(),
      this.runId
    );
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildAsyncCommitteeMembers() {
    if (this.syncMode !== 'async') {
      return [];
    }
    if (this.topology === 'centralized') {
      return [this.centralizedCoordinatorId];
    }

    const members = [];
    for (let i = 1; i <= this.org1NodeCount; i++) {
      members.push(`A-N${i}`);
    }
    for (let i = 1; i <= this.org2NodeCount; i++) {
      members.push(`B-N${i}`);
    }
    return members;
  }

  async startAsyncCommitteeFlow() {
    if (!this.isAsyncCommitteeMember || this.asyncAggregationLoopActive) {
      return;
    }

    this.asyncAggregationLoopActive = true;
    this.asyncAggregationLoopPromise = this.runAsyncAggregationLoop();
    const roleLabel = this.isAsyncCommitteeLeader
      ? 'async committee leader'
      : `async committee backup #${this.asyncCommitteeRank}`;
    console.log(`[${this.clientId}] Acting as ${roleLabel}`);
  }

  async stopAsyncCommitteeFlow() {
    this.asyncAggregationLoopActive = false;
    if (this.asyncAggregationLoopPromise) {
      try {
        await this.asyncAggregationLoopPromise;
      } catch (err) {
        console.warn(`[${this.clientId}] Async committee loop shutdown warning: ${this.getErrMessage(err)}`);
      }
      this.asyncAggregationLoopPromise = null;
    }
  }

  async runAsyncAggregationLoop() {
    while (this.asyncAggregationLoopActive) {
      try {
        await this.processAsyncAggregationTick();
      } catch (err) {
        console.warn(`[${this.clientId}] Async committee tick skipped: ${this.getErrMessage(err)}`);
      }
      await this.sleep(1000);
    }
  }

  async processAsyncAggregationTick(options = {}) {
    const { allowPartial = false } = options;
    this.lastAggregationTiming = null;
    if (!this.fabricClient) {
      return;
    }

    const pendingUpdates = await this.fabricClient.getPendingAsyncUpdates(this.asyncBatchSize);
    const availableCount = Array.isArray(pendingUpdates) ? pendingUpdates.length : 0;
    const oldestAgeMs =
      availableCount > 0 && pendingUpdates[0] && pendingUpdates[0].timestamp
        ? Date.now() - Number(pendingUpdates[0].timestamp) * 1000
        : 0;

    const fullBatchReady = availableCount >= this.asyncBatchSize;
    const partialBatchReady =
      allowPartial && availableCount > 0 && oldestAgeMs >= this.asyncPendingTimeoutMs;
    if (!fullBatchReady && !partialBatchReady) {
      return;
    }

    if (this.asyncCommitteeRank > 0) {
      await this.sleep(this.asyncCommitteeRank * this.asyncCommitteeTakeoverMs);
    }

    const targetCount = fullBatchReady ? this.asyncBatchSize : availableCount;
    const minUpdates = fullBatchReady ? this.asyncBatchSize : 1;

    if (targetCount < minUpdates) {
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const freshPendingUpdates = await this.fabricClient.getPendingAsyncUpdates(targetCount);
      const txIds = Array.isArray(freshPendingUpdates)
        ? freshPendingUpdates.slice(0, targetCount).map((entry) => entry.txId)
        : [];

      if (txIds.length < minUpdates) {
        return;
      }

      try {
        const phaseStart = Date.now();
        const result = await this.fabricClient.aggregateAsyncBatch(txIds, minUpdates);
        this.lastAggregationTiming = {
          globalAggregationMs: Date.now() - phaseStart,
          aggregatedCount: result ? result.aggregatedCount : null,
          version: result ? result.version : null,
        };
        if (result) {
          console.log(
            `[${this.clientId}] Aggregated ASYNC batch of ${result.aggregatedCount} update(s) into version ${result.version}`
          );
        }
        return;
      } catch (err) {
        const msg = this.getErrMessage(err);
        if (
          msg.includes('already consumed') ||
          msg.includes('not enough async updates to aggregate')
        ) {
          await this.sleep(150);
          continue;
        }
        if (this.isConnectionError(msg)) {
          await this.reconnectFabricClient();
          await this.sleep(200);
          continue;
        }
        if (
          msg.includes('MVCC_READ_CONFLICT') ||
          msg.includes('PHANTOM_READ_CONFLICT') ||
          msg.includes('Peer endorsements do not match') ||
          msg.includes('endorsements do not match')
        ) {
          await this.sleep(200 + attempt * 100);
          continue;
        }
        throw err;
      }
    }
  }

  async waitForAsyncDrain(graceMs = 15000) {
    if (!this.isAsyncCommitteeMember) {
      return;
    }

    const deadline = Date.now() + graceMs;
    let consecutiveEmptyChecks = 0;

    while (Date.now() < deadline) {
      await this.processAsyncAggregationTick({ allowPartial: true });
      const pendingUpdates = await this.fabricClient.getPendingAsyncUpdates(1);
      if (!Array.isArray(pendingUpdates) || pendingUpdates.length === 0) {
        consecutiveEmptyChecks += 1;
        if (consecutiveEmptyChecks >= 3) {
          return;
        }
      } else {
        consecutiveEmptyChecks = 0;
      }
      await this.sleep(1000);
    }
  }

  getErrMessage(err) {
    return String(err && err.message ? err.message : err || '');
  }

  isIdempotentSuccess(msg) {
    return (
      msg.includes('already initialized') ||
      msg.includes('already submitted for round') ||
      msg.includes('already submitted by node') ||
      msg.includes('org round') && msg.includes('already completed') ||
      msg.includes('already completed') ||
      msg.includes('already finalized')
    );
  }

  isRetryable(msg) {
    return (
      msg.includes('MVCC_READ_CONFLICT') ||
      msg.includes('PHANTOM_READ_CONFLICT') ||
      msg.includes('not ready') ||
      msg.includes('Peer endorsements do not match') ||
      msg.includes('endorsements do not match') ||
      msg.includes('org round') && msg.includes('not ready') ||
      (msg.includes('round') && msg.includes('not initialized')) ||
      msg.includes('not enough async updates to aggregate')
    );
  }

  isFatalConfigError(msg) {
    return msg.includes('collection') && msg.includes('could not be found');
  }

  isModelNotReady(msg) {
    return msg.includes('global model not found for round');
  }

  isRoundNotReady(msg) {
    return (
      msg.includes('round') && msg.includes('not ready')
    );
  }

  isConnectionError(msg) {
    return (
      msg.includes('is not connected') ||
      msg.includes('not running chaincode contracts') ||
      msg.includes('No valid responses from any peers') ||
      msg.includes('failed to connect')
    );
  }

  async reconnectFabricClient() {
    try {
      if (this.fabricClient) {
        await this.fabricClient.disconnect();
      }
    } catch (err) {
      // Ignore disconnect errors during reconnect.
    }

    this.fabricClient = new FabricClient(this.fabricClientOptions);
    await this.fabricClient.connect();
    console.log(`[${this.clientId}] Reconnected to Fabric (${this.peerName})`);
  }

  async verifyFabricReady() {
    await this.withRetry(
      'StartupFabricHealthCheck',
      async () => {
        await this.fabricClient.getCurrentRound();
      },
      {
        attempts: 4,
        initialDelayMs: 250,
        reconnectOnConnectionError: true,
        treatIdempotentAsSuccess: false,
      }
    );
  }

  async withRetry(label, fn, options = {}) {
    const {
      attempts = 8,
      initialDelayMs = 200,
      maxDelayMs = 2000,
      treatIdempotentAsSuccess = true,
      reconnectOnConnectionError = false,
    } = options;

    let delay = initialDelayMs;
    let hasReconnected = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = this.getErrMessage(err);

        if (reconnectOnConnectionError && !hasReconnected && this.isConnectionError(msg)) {
          try {
            await this.reconnectFabricClient();
            hasReconnected = true;
          } catch (reconnectErr) {
            console.warn(`[${this.clientId}] Reconnect failed: ${this.getErrMessage(reconnectErr)}`);
          }
        }

        if (treatIdempotentAsSuccess && this.isIdempotentSuccess(msg)) {
          console.log(`[${this.clientId}] ${label}: idempotent success (${msg})`);
          return null;
        }

        if (this.isFatalConfigError(msg)) {
          throw err;
        }

        if (!this.isRetryable(msg) || attempt === attempts) {
          throw err;
        }

        const jitter = Math.floor(Math.random() * 100);
        await this.sleep(Math.min(delay, maxDelayMs) + jitter);
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }

    return null;
  }

  async waitForContractSignal(label, fetchStatus, isReady, options = {}) {
    const {
      attempts = 40,
      intervalMs = 1000,
      reconnectOnConnectionError = true,
    } = options;

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const status = await fetchStatus();
        if (isReady(status)) {
          return status;
        }
      } catch (err) {
        lastError = err;
        if (reconnectOnConnectionError && this.isConnectionError(this.getErrMessage(err))) {
          try {
            await this.reconnectFabricClient();
          } catch (reconnectErr) {
            console.warn(`[${this.clientId}] ${label} reconnect failed: ${this.getErrMessage(reconnectErr)}`);
          }
        }
      }

      if (attempt < attempts) {
        await this.sleep(intervalMs);
      }
    }

    if (lastError) {
      throw new Error(`${label} timed out: ${this.getErrMessage(lastError)}`);
    }
    throw new Error(`${label} timed out: readiness condition not met`);
  }

  async trainOneEpoch() {
    console.log(`[${this.clientId}] Training for 1 epoch...`);
    
    if (this.dataset === 'linear') {
      const xs = tf.reshape(this.localData.xs, [-1, 1]);
      await this.model.fit(xs, this.localData.ys, {
        epochs: 1,
        batchSize: 8,
        verbose: 0,
      });
      xs.dispose();
    } else if (this.dataset === 'mnist' || this.dataset === 'cifar') {
      // MNIST/CIFAR: reshape flattened images to CNN input format
      const images = this.localData.images;
      const labels = this.localData.labels;
      
      // Flatten nested array structure and create 4D tensor
      const imageData = [];
      for (let img of images) {
        imageData.push(...img);
      }

      const shape = this.dataset === 'mnist'
        ? [images.length, 28, 28, 1]
        : [images.length, 32, 32, 3];

      const xs = tf.tensor4d(imageData, shape);
      const ys = tf.tensor2d(labels);
      
      await this.model.fit(xs, ys, {
        epochs: 1,
        batchSize: 32,
        verbose: 0,
      });
      
      xs.dispose();
      ys.dispose();
    }
    
    console.log(`[${this.clientId}] Epoch training complete`);
  }

  getLocalModelUpdate() {
    if (this.dataset === 'linear') {
      const weights = this.model.getWeights();
      const w = weights[0].dataSync()[0]; // weight parameter
      const b = weights[1].dataSync()[0]; // bias parameter
      return [w, b];
    } else if (this.dataset === 'mnist' || this.dataset === 'cifar') {
      // Serialize CNN weights as flattened 1D array
      return this.dataLoader.serializeModelUpdate(this.model);
    }
    throw new Error(`Unknown dataset: ${this.dataset}`);
  }

  async submitUpdateToChain(epoch) {
    if (!this.fabricClient) {
      console.log(`[${this.clientId}] Not connected to Fabric, skipping submission`);
      return false;
    }

    this.lastSubmissionTiming = null;

    const update = this.getLocalModelUpdate();
    const value = JSON.stringify(update);
    const collection = this.orgMspId === 'Org1MSP' ? 'vpsaOrg1Shards' : 'vpsaOrg2Shards';
    const nodeID = String(this.nodeId);
    const branchStartedAtMs = Date.now();
    let nodeSubmitMs = null;
    let orgFinalizeMs = null;
    let globalAggregationMs = null;

    try {
      if (this.syncMode === 'sync' && this.topology === 'decentralized') {
        await this.withRetry(
          `InitHierarchicalRound(${epoch})`,
          () => this.fabricClient.initHierarchicalRound(epoch, 2, this.org1NodeCount, this.org2NodeCount),
          { attempts: 8, initialDelayMs: 150, reconnectOnConnectionError: true }
        );

        const aggregationStageStartedAtMs = Date.now();
        let phaseStart = Date.now();
        await this.withRetry(
          `SubmitLocalNodeUpdateSync(${epoch}, node=${nodeID})`,
          () =>
            this.fabricClient.submitLocalNodeUpdateSync(
              collection,
              epoch,
              nodeID,
              value,
              this.localData.sampleCount
            ),
          { attempts: 10, initialDelayMs: 200, reconnectOnConnectionError: true }
        );
        nodeSubmitMs = Date.now() - phaseStart;
        console.log(`[${this.clientId}] Submitted node-level SYNC update for epoch ${epoch}`);

        // Contract signal 1: wait until all nodes in this org submitted before org finalize.
        await this.waitForContractSignal(
          `OrgRoundReady(${epoch}, ${this.orgMspId})`,
          () => this.fabricClient.getOrgRoundStatus(epoch, this.orgMspId),
          (status) =>
            status &&
            Array.isArray(status.submittedNodeIds) &&
            Number.isInteger(status.expectedNodes) &&
            status.submittedNodeIds.length >= status.expectedNodes,
          { attempts: 60, intervalMs: 1000 }
        );

        phaseStart = Date.now();
        await this.withRetry(
          `FinalizeOrgSyncRound(${epoch})`,
          () => this.fabricClient.finalizeOrgSyncRound(epoch),
          { attempts: 20, initialDelayMs: 250, reconnectOnConnectionError: true }
        );
        orgFinalizeMs = Date.now() - phaseStart;
        console.log(`[${this.clientId}] Finalized org-level sync epoch ${epoch}`);

        // Contract signal 2: wait until both org-level updates are submitted before global finalize.
        await this.waitForContractSignal(
          `RoundReadyForGlobalFinalize(${epoch})`,
          () => this.fabricClient.getRoundStatus(epoch),
          (status) =>
            status &&
            Array.isArray(status.submittedOrgs) &&
            Number.isInteger(status.expectedCount) &&
            status.submittedOrgs.length >= status.expectedCount,
          { attempts: 60, intervalMs: 1000 }
        );

        phaseStart = Date.now();
        await this.withRetry(
          `FinalizeSyncRound(${epoch})`,
          () => this.fabricClient.finalizeSyncRound(epoch),
          { attempts: 30, initialDelayMs: 250, reconnectOnConnectionError: true }
        );
        const syncAggregationTiming = await this.withRetry(
          `GetSyncAggregationTiming(${epoch})`,
          () => this.fabricClient.getSyncAggregationTiming(epoch),
          { attempts: 8, initialDelayMs: 100, reconnectOnConnectionError: true, treatIdempotentAsSuccess: false }
        );
        globalAggregationMs = syncAggregationTiming.durationMs;
        this.lastSubmissionTiming = {
          nodeSubmitMs,
          orgFinalizeMs,
          globalAggregationMs,
          stageTotalMs: globalAggregationMs,
          chaincodeStartedAtMs: syncAggregationTiming.startedAt,
          chaincodeEndedAtMs: syncAggregationTiming.endedAt,
        };
        console.log(`[${this.clientId}] Finalized sync epoch ${epoch}`);
      } else if (this.syncMode === 'sync' && this.topology === 'centralized') {
        if (this.isCentralizedCoordinator) {
          await this.withRetry(
            `InitCentralizedRound(${epoch})`,
            () => this.fabricClient.initCentralizedRound(epoch, this.org1NodeCount + this.org2NodeCount),
            { attempts: 8, initialDelayMs: 150, reconnectOnConnectionError: true }
          );
          this.notifyCoordinatorRoundInitialized(epoch);
        } else {
          await this.waitForCentralizedRoundInitialized(epoch);
        }

        if (!this.isCentralizedCoordinator) {
          // Spread submissions to avoid overloading a single peer endpoint in short bursts.
          const submitSkewMs = this.submitOrderIndex * 350;
          if (submitSkewMs > 0) {
            await this.sleep(submitSkewMs);
          }
        }

        let phaseStart = Date.now();
        await this.withRetry(
          `SubmitLocalUpdateCentralized(${epoch}, node=${nodeID})`,
          () =>
            this.fabricClient.submitLocalUpdateCentralized(
              collection,
              epoch,
              nodeID,
              value,
              this.localData.sampleCount
            ),
          { attempts: 10, initialDelayMs: 200, reconnectOnConnectionError: true }
        );
        nodeSubmitMs = Date.now() - phaseStart;
        console.log(`[${this.clientId}] Submitted node-level CENTRALIZED update for epoch ${epoch}`);

        if (this.isCentralizedCoordinator) {
          await this.waitForContractSignal(
            `CentralizedRoundReady(${epoch})`,
            () => this.fabricClient.getRoundStatus(epoch),
            (status) =>
              status &&
              Array.isArray(status.submittedNodes) &&
              Number.isInteger(status.expectedCount) &&
              status.submittedNodes.length >= status.expectedCount,
            { attempts: 60, intervalMs: 1000 }
          );

          phaseStart = Date.now();
          await this.withRetry(
            `FinalizeCentralizedRound(${epoch})`,
            () => this.fabricClient.finalizeCentralizedRound(epoch),
            { attempts: 30, initialDelayMs: 250, reconnectOnConnectionError: true }
          );
          const centralizedAggregationTiming = await this.withRetry(
            `GetCentralizedAggregationTiming(${epoch})`,
            () => this.fabricClient.getCentralizedAggregationTiming(epoch),
            { attempts: 8, initialDelayMs: 100, reconnectOnConnectionError: true, treatIdempotentAsSuccess: false }
          );
          globalAggregationMs = centralizedAggregationTiming.durationMs;
          this.lastSubmissionTiming = {
            nodeSubmitMs,
            orgFinalizeMs,
            globalAggregationMs,
            stageTotalMs: globalAggregationMs,
            chaincodeStartedAtMs: centralizedAggregationTiming.startedAt,
            chaincodeEndedAtMs: centralizedAggregationTiming.endedAt,
          };
          console.log(`[${this.clientId}] Finalized centralized epoch ${epoch}`);
        } else {
          await this.waitForContractSignal(
            `CentralizedRoundFinalized(${epoch})`,
            () => this.fabricClient.getRoundStatus(epoch),
            (status) => status && status.aggregationDone === true,
            { attempts: 60, intervalMs: 1000 }
          );

          const centralizedAggregationTiming = await this.withRetry(
            `GetCentralizedAggregationTiming(${epoch})`,
            () => this.fabricClient.getCentralizedAggregationTiming(epoch),
            { attempts: 8, initialDelayMs: 100, reconnectOnConnectionError: true, treatIdempotentAsSuccess: false }
          );
          globalAggregationMs = centralizedAggregationTiming.durationMs;
          this.lastSubmissionTiming = {
            nodeSubmitMs,
            orgFinalizeMs,
            globalAggregationMs,
            stageTotalMs: globalAggregationMs,
            chaincodeStartedAtMs: centralizedAggregationTiming.startedAt,
            chaincodeEndedAtMs: centralizedAggregationTiming.endedAt,
          };
          console.log(`[${this.clientId}] Observed centralized epoch ${epoch} completion`);
        }
      } else {
        const phaseStart = Date.now();
        const submitResult = await this.withRetry(
          'SubmitLocalUpdateAsync',
          () =>
            this.fabricClient.submitLocalUpdateAsync(
              collection,
              value,
              this.localData.sampleCount,
              this.currentBaselineVersion || 0
            ),
          { attempts: 8, initialDelayMs: 200, reconnectOnConnectionError: true }
        );
        nodeSubmitMs = Date.now() - phaseStart;

        console.log(
          `[${this.clientId}] Submitted ASYNC update (txId=${submitResult.txId}, baselineVersion=${this.currentBaselineVersion || 0})`
        );
        this.lastSubmissionTiming = {
          nodeSubmitMs,
          orgFinalizeMs,
          globalAggregationMs,
          stageTotalMs: Date.now() - branchStartedAtMs,
        };
      }
      return true;
    } catch (err) {
      const msg = this.getErrMessage(err);
      if (msg.includes('collection') && msg.includes('could not be found')) {
        console.error(
          `[${this.clientId}] Failed to submit update: training PDC collections missing. ` +
            `Redeploy network with: ./deploy.sh --strategy vpsa`
        );
        return false;
      }
      console.error(`[${this.clientId}] Failed to submit update:`, err.message);
      return false;
    }
  }

  async queryGlobalModel(epoch) {
    if (!this.fabricClient) {
      console.log(`[${this.clientId}] Not connected to Fabric, cannot query`);
      return null;
    }

    const waitForSyncRoundFinalized = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 12; attempt++) {
        try {
          const status = await this.fabricClient.getRoundStatus(epoch);
          if (status && status.aggregationDone) {
            return true;
          }
        } catch (err) {
          lastError = err;
          if (this.isConnectionError(this.getErrMessage(err))) {
            try {
              await this.reconnectFabricClient();
            } catch (reconnectErr) {
              console.warn(`[${this.clientId}] Status reconnect failed: ${this.getErrMessage(reconnectErr)}`);
            }
          }
        }

        if (attempt < 12) {
          await this.sleep(1500);
        }
      }

      if (lastError) {
        console.log(`[${this.clientId}] Round status check timed out: ${lastError.message}`);
      }
      return false;
    };

    // Query with retry for modes that publish a round-scoped global model.
    const retryQuerySync = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 10; attempt++) {
        try {
          const globalModel = await this.fabricClient.getGlobalModel(epoch);
          console.log(`[${this.clientId}] Retrieved ${this.topology.toUpperCase()}-${this.syncMode.toUpperCase()} global model for epoch ${epoch}`);
          return globalModel;
        } catch (err) {
          lastError = err;
          const msg = this.getErrMessage(err);

          if (attempt < 10 && this.isModelNotReady(msg)) {
            console.log(`[${this.clientId}] Query attempt ${attempt} model not ready, retrying in 2s...`);
            await this.sleep(2000);
            continue;
          }

          if (attempt < 10 && this.isRoundNotReady(msg)) {
            console.log(`[${this.clientId}] Query attempt ${attempt} round not ready, retrying in 2s...`);
            await this.sleep(2000);
            continue;
          }

          if (attempt < 10) {
            if (this.isConnectionError(msg)) {
              try {
                await this.reconnectFabricClient();
              } catch (reconnectErr) {
                console.warn(`[${this.clientId}] Query reconnect failed: ${this.getErrMessage(reconnectErr)}`);
              }
            }
            await this.sleep(1500);
          }
        }
      }
      throw lastError;
    };

    try {
      if (this.syncMode === 'sync') {
        await waitForSyncRoundFinalized();
        return await retryQuerySync();
      }

      const version = await this.fabricClient.getLatestModelVersion();
      const globalModel = await this.fabricClient.getGlobalModelByVersion(version);
      console.log(`[${this.clientId}] Retrieved ASYNC global model version ${version}`);
      return globalModel;
    } catch (err) {
      console.log(`[${this.clientId}] Error querying global model: ${err.message}`);
      return null;
    }
  }

  updateModelFromGlobal(globalModel) {
    this.modelInitValid = false;
    if (!globalModel) return;
    try {
      const parsed = JSON.parse(globalModel.modelData);
      const refreshedModel = this.dataLoader.buildModel();
      if (this.dataset === 'linear') {
        // Linear format: [w, b]
        if (!Array.isArray(parsed) || parsed.length < 2) {
          console.log(`[${this.clientId}] Global modelData format invalid, skip local update`);
          refreshedModel.dispose();
          return;
        }
        const [w, b] = parsed;
        refreshedModel.setWeights([
          tf.tensor2d([w], [1, 1]),
          tf.tensor1d([b]),
        ]);
        this.modelInitValid = true;
        console.log(`[${this.clientId}] Updated local model from global: w=${w}, b=${b}`);
      } else if (this.dataset === 'mnist' || this.dataset === 'cifar') {
        // CNN format: flattened 1D array, use dataLoader to unflatten
        if (!Array.isArray(parsed)) {
          console.log(`[${this.clientId}] Global modelData format invalid, expected array`);
          refreshedModel.dispose();
          return;
        }
        try {
          this.dataLoader.deserializeGlobalModel(parsed, refreshedModel);
          this.modelInitValid = true;
          console.log(`[${this.clientId}] Updated ${this.dataset.toUpperCase()} CNN model from global (${parsed.length} params)`);
        } catch (e) {
          console.log(`[${this.clientId}] Global modelData shape mismatch: ${e.message}`);
          refreshedModel.dispose();
          return;
        }
      }
      if (this.model) {
        this.model.dispose();
      }
      this.model = refreshedModel;
    } catch (err) {
      console.log(`[${this.clientId}] Failed to parse global modelData: ${err.message}`);
    }
  }

  async loadLatestGlobalModel() {
    this.modelInitValid = false;
    try {
      console.log(`[${this.clientId}] Checking for latest global model on chain...`);
      if (this.syncMode === 'async') {
        const latestVersion = await this.fabricClient.getLatestModelVersion();
        if (!this.resume && latestVersion > 0) {
          throw new Error(
            `found existing async version ${latestVersion} on chain while --resume=false; ` +
              `redeploy network for a fresh run or set --resume true`
          );
        }
        if (latestVersion === 0) {
          console.log(`[${this.clientId}] No previous async versions found, starting fresh`);
          return 0;
        }
        const globalModel = await this.fabricClient.getGlobalModelByVersion(latestVersion);
        if (globalModel && globalModel.modelData) {
          this.updateModelFromGlobal(globalModel);
          if (this.modelInitValid) {
            this.currentBaselineVersion = latestVersion;
            this.latestAvailableVersion = latestVersion;
            console.log(`[${this.clientId}] Successfully initialized from async version ${latestVersion}`);
            return latestVersion;
          } else {
            console.log(`[${this.clientId}] Global model shape mismatch, using random initialization`);
            return 0;
          }
        }
        console.log(`[${this.clientId}] Async global model v${latestVersion} missing, using random initialization`);
        return 0;
      }
      const currentRound = await this.fabricClient.getCurrentRound();
      if (!this.resume && currentRound > 0) {
        throw new Error(
          `found existing completed round ${currentRound} on chain while --resume=false; ` +
            `redeploy network for a fresh run or set --resume true`
        );
      }
      if (currentRound === 0) {
        console.log(`[${this.clientId}] No previous training rounds found, starting fresh`);
        return 0;
      }
      console.log(`[${this.clientId}] Found completed round ${currentRound}, loading global model...`);
      const globalModel = await this.fabricClient.getGlobalModel(currentRound);
      if (globalModel && globalModel.modelData) {
        this.updateModelFromGlobal(globalModel);
        if (this.modelInitValid) {
          console.log(`[${this.clientId}] Successfully initialized from round ${currentRound} model`);
          return currentRound;
        } else {
          console.log(`[${this.clientId}] Global model shape mismatch, using random initialization`);
          return 0;
        }
      }
      console.log(`[${this.clientId}] Global model not found for round ${currentRound}, using random initialization`);
      return 0;
    } catch (err) {
      if (!this.resume && err && String(err.message || '').includes('--resume=false')) {
        throw err;
      }
      console.warn(`[${this.clientId}] Failed to load latest model: ${err.message}, continuing with random initialization`);
      return 0;
    }
  }

  saveGlobalModelToFile(globalModel, index) {
    try {
      const modelsDir = this.getModelStorageDir();
      
      // Ensure models directory exists
      if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
      }
      
      const isAsync = this.syncMode === 'async';
      const effectiveVersion = Number.isInteger(globalModel.version) && globalModel.version > 0
        ? globalModel.version
        : index;
      const effectiveRound = Number.isInteger(globalModel.round) && globalModel.round > 0
        ? globalModel.round
        : index;

      const filename = isAsync
        ? `global-model-version-${effectiveVersion}.json`
        : `global-model-round-${effectiveRound}.json`;
      const filepath = path.join(modelsDir, filename);
      
      // Save the complete global model object
      const modelToSave = {
        runId: this.runId,
        mode: this.mode,
        executionMode: this.getExecutionModeGroup(),
        topology: this.getTopologyGroup(),
        round: effectiveRound,
        version: effectiveVersion,
        timestamp: globalModel.timestamp,
        modelData: globalModel.modelData,
        participants: globalModel.participants || [],
        participantCount: globalModel.participants ? globalModel.participants.length : 0,
        totalSamples: globalModel.totalSamples || 0
      };
      
      fs.writeFileSync(filepath, JSON.stringify(modelToSave, null, 2));
      console.log(
        `[${this.clientId}] Global model saved to models/${this.dataset}/${this.getExecutionModeGroup()}/${this.getTopologyGroup()}/${this.runId}/${filename}`
      );
      
      // Also save as "latest" for easy access
      const latestPath = path.join(modelsDir, 'global-model-latest.json');
      fs.writeFileSync(latestPath, JSON.stringify(modelToSave, null, 2));
      
      return filepath;
    } catch (err) {
      console.warn(`[${this.clientId}] Failed to save global model to file: ${err.message}`);
      return null;
    }
  }

  async cleanup() {
    if (this.isAsyncCommitteeMember) {
      await this.stopAsyncCommitteeFlow();
    }
    if (this.model) {
      this.model.dispose();
    }
    if (this.localData) {
      if (this.localData.xs && typeof this.localData.xs.dispose === 'function') {
        this.localData.xs.dispose();
      }
      if (this.localData.ys && typeof this.localData.ys.dispose === 'function') {
        this.localData.ys.dispose();
      }
    }
    if (this.fabricClient) {
      await this.fabricClient.disconnect();
    }
    console.log(`[${this.clientId}] Cleaned up`);
  }

  // ========== ASYNCHRONOUS TRAINING LOOP ==========
  // Non-blocking, bounded async: train continuously, submit updates regularly, fetch latest model periodically
  async trainAsync(totalSteps) {
    const pollIntervalMs = 2000;  // Poll for new version every 2s
    const stepsPerUpdate = 1;      // Submit after every local training step

    let completedStep = 0;
    let lastSubmitStep = 0;
    let lastVersionCheckMs = Date.now();
    
    console.log(`[${this.clientId}] Starting ASYNC training: ${totalSteps} total steps, model-update every ${stepsPerUpdate} steps`);

    while (completedStep < totalSteps) {
      const stepTiming = {
        step: completedStep,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        status: 'running',
      };

      // >>> LOCAL TRAINING STEP
      let phaseStart = Date.now();
      try {
        await this.trainOneEpoch(); // 1 epoch = ~1 local step
        stepTiming.localTrainMs = Date.now() - phaseStart;
      } catch (err) {
        stepTiming.error = err.message;
        stepTiming.status = 'train-failed';
        console.error(`[${this.clientId}] Training step ${completedStep} failed:`, err.message);
        stepTiming.endedAt = new Date().toISOString();
        stepTiming.endedAtMs = Date.now();
        stepTiming.totalMs = stepTiming.endedAtMs - stepTiming.startedAtMs;
        this.timing.rounds.push(stepTiming);
        break;
      }

      completedStep += 1;
      this.asyncStepCount = completedStep;

      // >>> PERIODIC SUBMIT (every N local steps)
      if (completedStep - lastSubmitStep >= stepsPerUpdate) {
        phaseStart = Date.now();
        const submitted = await this.submitUpdateToChain(completedStep); // Use step as version hint
        stepTiming.submitUpdateMs = Date.now() - phaseStart;
        if (this.lastSubmissionTiming) {
          stepTiming.globalAggregationMs = this.lastSubmissionTiming.globalAggregationMs;
          stepTiming.chaincodeAggregationMs = this.lastSubmissionTiming.globalAggregationMs;
          stepTiming.nodeSubmitMs = this.lastSubmissionTiming.nodeSubmitMs;
          stepTiming.orgFinalizeMs = this.lastSubmissionTiming.orgFinalizeMs;
          stepTiming.stageTotalMs = this.lastSubmissionTiming.stageTotalMs;
        }
        if (!submitted) {
          stepTiming.status = 'submit-failed';
          console.log(`[${this.clientId}] Async submit failed at step ${completedStep}, stopping`);
          stepTiming.endedAt = new Date().toISOString();
          stepTiming.endedAtMs = Date.now();
          stepTiming.totalMs = stepTiming.endedAtMs - stepTiming.startedAtMs;
          this.timing.rounds.push(stepTiming);
          break;
        }
        lastSubmitStep = completedStep;

        if (this.isAsyncCommitteeMember) {
          phaseStart = Date.now();
          try {
            await this.processAsyncAggregationTick();
            stepTiming.asyncAggregateTickMs = Date.now() - phaseStart;
            if (this.lastAggregationTiming) {
              stepTiming.globalAggregationMs = this.lastAggregationTiming.globalAggregationMs;
              stepTiming.chaincodeAggregationMs = this.lastAggregationTiming.globalAggregationMs;
              stepTiming.asyncAggregatedCount = this.lastAggregationTiming.aggregatedCount;
              stepTiming.asyncAggregationVersion = this.lastAggregationTiming.version;
            }
          } catch (err) {
            console.warn(`[${this.clientId}] Async aggregate tick skipped: ${this.getErrMessage(err)}`);
          }
        }
      }

      // >>> PERIODIC FETCH LATEST MODEL (non-blocking, every 2s of wall clock)
      const nowMs = Date.now();
      if (nowMs - lastVersionCheckMs >= pollIntervalMs) {
        phaseStart = Date.now();
        try {
          const latestVersion = await this.fabricClient.getLatestModelVersion();
          stepTiming.checkVersionMs = Date.now() - phaseStart;
          
          if (latestVersion > this.latestAvailableVersion) {
            this.latestAvailableVersion = latestVersion;
            
            // Non-blocking fetch and apply global model
            phaseStart = Date.now();
            const globalModel = await this.fabricClient.getGlobalModelByVersion(latestVersion);
            stepTiming.fetchGlobalModelMs = Date.now() - phaseStart;
            
            if (globalModel) {
              phaseStart = Date.now();
              this.updateModelFromGlobal(globalModel);
              this.currentBaselineVersion = latestVersion; // Update baseline for next submissions
              stepTiming.applyGlobalModelMs = Date.now() - phaseStart;
              
              // Save to file
              phaseStart = Date.now();
              this.saveGlobalModelToFile(globalModel, latestVersion);
              stepTiming.saveGlobalModelMs = Date.now() - phaseStart;
              
              console.log(`[${this.clientId}] Applied global model v${latestVersion} at step ${completedStep}`);
            }
          }
        } catch (err) {
          // Non-critical: log but continue training
          console.warn(`[${this.clientId}] Failed to fetch latest version at step ${completedStep}:`, err.message);
        }
        lastVersionCheckMs = nowMs;
      }

      stepTiming.status = 'completed';
      stepTiming.endedAt = new Date().toISOString();
      stepTiming.endedAtMs = Date.now();
      stepTiming.totalMs = stepTiming.endedAtMs - stepTiming.startedAtMs;
      this.timing.rounds.push(stepTiming);
      this.writeTimingSnapshot();

      // Small delay to prevent busy spinning
      await this.sleep(100);
    }

    if (this.isAsyncCommitteeMember) {
      try {
        await this.waitForAsyncDrain();
      } catch (err) {
        console.warn(`[${this.clientId}] Async drain skipped: ${this.getErrMessage(err)}`);
      }
    }

    console.log(`[${this.clientId}] ASYNC training completed: ${completedStep} steps`);
  }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('org', {
      type: 'string',
      required: true,
      describe: 'Organization shorthand (e.g., A, B)',
    })
    .option('node', {
      type: 'number',
      required: true,
      describe: 'Node ID within organization (e.g., 1, 2)',
    })
    .option('port', {
      type: 'number',
      required: true,
      describe: 'Port number (informational)',
    })
    .option('org-domain', {
      type: 'string',
      required: true,
      describe: 'Organization domain (e.g., org1.example.com)',
    })
    .option('org-msp-id', {
      type: 'string',
      required: true,
      describe: 'Organization MSP ID (e.g., Org1MSP)',
    })
    .option('peer-name', {
      type: 'string',
      required: true,
      describe: 'Peer name (e.g., peer0.org1.example.com)',
    })
    .option('peer-endpoint', {
      type: 'string',
      required: true,
      describe: 'Peer endpoint (e.g., localhost:7051)',
    })
    .option('orderer-endpoint', {
      type: 'string',
      default: 'localhost:7050',
      describe: 'Orderer endpoint',
    })
    .option('project-root', {
      type: 'string',
      default: path.join(__dirname, '..', '..'),
      describe: 'Project root directory',
    })
    .option('epochs', {
      type: 'number',
      default: 10,
      describe: 'Total number of training epochs (each epoch = 1 FL round)',
    })
    .option('mode', {
      type: 'string',
      coerce: (value) => String(value).toLowerCase(),
      choices: ['sync', 'decentralized', 'centralized', 'async'],
      describe: 'Legacy mode alias (deprecated): sync|decentralized|centralized|async',
    })
    .option('topology', {
      type: 'string',
      default: 'decentralized',
      coerce: (value) => String(value).toLowerCase(),
      choices: ['centralized', 'decentralized'],
      describe: 'Topology dimension: centralized or decentralized',
    })
    .option('sync-mode', {
      type: 'string',
      default: 'sync',
      coerce: (value) => String(value).toLowerCase(),
      choices: ['sync', 'async'],
      describe: 'Synchronization dimension: sync or async',
    })
    .option('resume', {
      type: 'boolean',
      default: false,
      describe: 'Resume from latest on-chain model/round instead of requiring a fresh network state',
    })
    .option('org1-node-count', {
      type: 'number',
      default: 2,
      describe: 'Expected number of participating nodes in Org1',
    })
    .option('org2-node-count', {
      type: 'number',
      default: 3,
      describe: 'Expected number of participating nodes in Org2',
    })
    .option('dataset', {
      type: 'string',
      default: 'linear',
      describe: 'Dataset to use: linear, mnist, cifar',
    })
    .option('mnist-samples', {
      type: 'number',
      default: 20000,
      describe: 'Total classification training samples (MNIST/CIFAR) to load before partitioning',
    })
    .parse();

  const client = new FlClient({
    org: argv.org,
    node: argv.node,
    port: argv.port,
    orgDomain: argv['org-domain'],
    orgMspId: argv['org-msp-id'],
    peerName: argv['peer-name'],
    peerEndpoint: argv['peer-endpoint'],
    ordererEndpoint: argv['orderer-endpoint'],
    projectRoot: argv['project-root'],
    mode: argv.mode,
    topology: argv.topology,
    syncMode: argv['sync-mode'],
    resume: argv.resume,
    org1NodeCount: argv['org1-node-count'],
    org2NodeCount: argv['org2-node-count'],
    dataset: argv.dataset,
    mnistSamples: argv['mnist-samples'],
  });

  let fatalError = null;
  let completedRounds = 0;
  let failedRound = null;

  try {
    await client.initialize();

    // Try to load latest global model from chain
    let phaseStart = Date.now();
    const lastCompletedRound = await client.loadLatestGlobalModel();
    client.timing.initialization.loadLatestGlobalModelMs = Date.now() - phaseStart;
    client.timing.initialization.lastCompletedRound = lastCompletedRound;
    client.timing.training = {
      requestedEpochs: argv.epochs,
      startRound: lastCompletedRound + 1,
      endRound: lastCompletedRound + argv.epochs,
      dataset: argv.dataset,
      mode: client.mode,
      topology: client.topology,
      syncMode: client.syncMode,
    };
    client.writeTimingSnapshot();
    
    console.log(`\n[${client.clientId}] Starting ${client.topology.toUpperCase()}-${client.syncMode.toUpperCase()} training with ${argv.epochs} rounds`);

    // Choose training strategy based on mode
    if (client.syncMode === 'async') {
      // ASYNC MODE: Non-blocking, bounded async training
      console.log(`[${client.clientId}] Using asynchronous training loop (no round barrier)`);
      await client.trainAsync(argv.epochs);
    } else {
      // SYNC/CENTRALIZED MODE: Round-based training with on-chain aggregation barrier.
      const modeLabel = client.topology === 'centralized' ? 'centralized synchronous' : 'decentralized synchronous';
      console.log(`[${client.clientId}] Using ${modeLabel} training loop (with round barrier)`);
      // FL training: each epoch triggers one round of aggregation
      for (let epoch = 1; epoch <= argv.epochs; epoch++) {
        const currentRound = lastCompletedRound + epoch;
        const roundTiming = {
          epoch,
          round: currentRound,
          startedAt: new Date().toISOString(),
          startedAtMs: Date.now(),
          status: 'running',
        };
        console.log(`\n========== Epoch ${epoch}/${argv.epochs} (Round ${currentRound}) ==========`);

        // Local training for 1 epoch
        phaseStart = Date.now();
        await client.trainOneEpoch();
        roundTiming.localTrainMs = Date.now() - phaseStart;

        // Small delay to simulate network latency
        phaseStart = Date.now();
        await new Promise((r) => setTimeout(r, 1000));
        roundTiming.postTrainDelayMs = Date.now() - phaseStart;

        // Submit update to chain (use actual round number)
      phaseStart = Date.now();
      const submitted = await client.submitUpdateToChain(currentRound);
      roundTiming.submitUpdateMs = Date.now() - phaseStart;
        if (client.lastSubmissionTiming) {
          roundTiming.globalAggregationMs = client.lastSubmissionTiming.globalAggregationMs;
          roundTiming.chaincodeAggregationMs = client.lastSubmissionTiming.globalAggregationMs;
          roundTiming.nodeSubmitMs = client.lastSubmissionTiming.nodeSubmitMs;
          roundTiming.orgFinalizeMs = client.lastSubmissionTiming.orgFinalizeMs;
          roundTiming.stageTotalMs = client.lastSubmissionTiming.stageTotalMs;
        }
      if (!submitted) {
        roundTiming.status = 'submit-failed';
        roundTiming.endedAt = new Date().toISOString();
        roundTiming.endedAtMs = Date.now();
        roundTiming.totalMs = roundTiming.endedAtMs - roundTiming.startedAtMs;
        client.timing.rounds.push(roundTiming);
        client.writeTimingSnapshot();
        failedRound = currentRound;
        console.log(`[${client.clientId}] Stop training: failed to submit update for round ${currentRound}`);
        break;
      }

      // Contract-signal flow: sync and centralized modes directly enter status-driven query path.
      if (client.syncMode === 'sync') {
        console.log(`[${client.clientId}] Waiting for on-chain ready signal...`);
      } else {
        // Async mode keeps a short settle delay to avoid immediate hot polling.
        phaseStart = Date.now();
        await new Promise((r) => setTimeout(r, 500));
        roundTiming.asyncSettleDelayMs = Date.now() - phaseStart;
      }

      // Query and apply global model (use actual round number)
      phaseStart = Date.now();
      const globalModel = await client.queryGlobalModel(currentRound);
      roundTiming.queryGlobalModelMs = Date.now() - phaseStart;
      if (globalModel) {
        phaseStart = Date.now();
        client.updateModelFromGlobal(globalModel);
        roundTiming.applyGlobalModelMs = Date.now() - phaseStart;
        // Save global model to local file
        phaseStart = Date.now();
        client.saveGlobalModelToFile(globalModel, currentRound);
        roundTiming.saveGlobalModelMs = Date.now() - phaseStart;
        roundTiming.status = 'completed';
        completedRounds += 1;
      } else {
        roundTiming.status = 'global-model-unavailable';
        failedRound = currentRound;
        console.log(`[${client.clientId}] Stop training: global model unavailable for round ${currentRound}`);
        roundTiming.endedAt = new Date().toISOString();
        roundTiming.endedAtMs = Date.now();
        roundTiming.totalMs = roundTiming.endedAtMs - roundTiming.startedAtMs;
        client.timing.rounds.push(roundTiming);
        client.writeTimingSnapshot();
        break;
      }

      roundTiming.endedAt = new Date().toISOString();
      roundTiming.endedAtMs = Date.now();
      roundTiming.totalMs = roundTiming.endedAtMs - roundTiming.startedAtMs;
      client.timing.rounds.push(roundTiming);
      client.writeTimingSnapshot();
      }

      client.timing.training.completedRounds = completedRounds;
      if (failedRound !== null) {
        client.timing.training.failedRound = failedRound;
      }
      if (failedRound === null && completedRounds === argv.epochs) {
        console.log(`\n[${client.clientId}] All epochs completed (${argv.epochs} FL rounds)`);
      } else {
        console.log(
          `\n[${client.clientId}] Training stopped early: completed=${completedRounds}/${argv.epochs}, failedRound=${failedRound}`
        );
        process.exitCode = 1;
      }
    }
  } catch (err) {
    fatalError = err;
    client.timing.error = {
      message: String(err && err.message ? err.message : err),
      stack: err && err.stack ? err.stack : null,
    };
    console.error(`[${client.clientId}] Fatal error:`, err);
    process.exitCode = 1;
  } finally {
    client.timing.training.completedRounds = completedRounds;
    if (failedRound !== null) {
      client.timing.training.failedRound = failedRound;
    }
    client.finalizeTiming(fatalError || failedRound !== null ? 'failed' : 'completed');
    await client.cleanup();

    // When launched with an IPC channel, explicitly disconnect so Node can exit.
    if (typeof process.disconnect === 'function' && process.connected) {
      process.disconnect();
    }
  }
}

main().catch(console.error);
