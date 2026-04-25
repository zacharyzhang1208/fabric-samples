const fs = require('fs');
const path = require('path');
const { Gateway } = require('fabric-network');
const config = require('./config');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readFirstFile(dirPath) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(
      `Missing crypto directory: ${dirPath}. Run './deploy.sh --strategy vpsa' first (or regenerate organizations).`
    );
  }
  const files = fs.readdirSync(dirPath);
  if (!files.length) {
    throw new Error(`No files found in directory: ${dirPath}`);
  }
  return path.join(dirPath, files[0]);
}

function buildIdentity(runtimeConfig) {
  const base = path.join(
    runtimeConfig.projectRoot,
    'organizations',
    'peerOrganizations',
    runtimeConfig.orgDomain,
    'users',
    `Admin@${runtimeConfig.orgDomain}`,
    'msp'
  );

  const certPath = path.join(base, 'signcerts', `Admin@${runtimeConfig.orgDomain}-cert.pem`);
  const keyDir = path.join(base, 'keystore');
  const keyPath = readFirstFile(keyDir);

  if (!fs.existsSync(certPath)) {
    throw new Error(
      `Missing admin cert: ${certPath}. Run './deploy.sh --strategy vpsa' first (or regenerate organizations).`
    );
  }

  return {
    credentials: {
      certificate: readUtf8(certPath),
      privateKey: readUtf8(keyPath),
    },
    mspId: runtimeConfig.orgMspId,
    type: 'X.509',
  };
}

function buildConnectionProfile(runtimeConfig) {
  const peerTlsPath = path.join(
    runtimeConfig.projectRoot,
    'organizations',
    'peerOrganizations',
    runtimeConfig.orgDomain,
    'peers',
    runtimeConfig.peerName,
    'tls',
    'ca.crt'
  );

  const ordererTlsPath = path.join(
    runtimeConfig.projectRoot,
    'organizations',
    'ordererOrganizations',
    'example.com',
    'orderers',
    'orderer.example.com',
    'tls',
    'ca.crt'
  );

  return {
    name: 'my-network-client',
    version: '1.0.0',
    channels: {
      [runtimeConfig.channelName]: {
        peers: {
          [runtimeConfig.peerName]: {},
        },
        orderers: ['orderer.example.com'],
      },
    },
    organizations: {
      [runtimeConfig.orgMspId]: {
        mspid: runtimeConfig.orgMspId,
        peers: [runtimeConfig.peerName],
      },
    },
    peers: {
      [runtimeConfig.peerName]: {
        url: `grpcs://${runtimeConfig.peerEndpoint}`,
        tlsCACerts: {
          pem: readUtf8(peerTlsPath),
        },
        grpcOptions: {
          'ssl-target-name-override': runtimeConfig.peerHostAlias,
          hostnameOverride: runtimeConfig.peerHostAlias,
        },
      },
    },
    orderers: {
      'orderer.example.com': {
        url: `grpcs://${runtimeConfig.ordererEndpoint}`,
        tlsCACerts: {
          pem: readUtf8(ordererTlsPath),
        },
        grpcOptions: {
          'ssl-target-name-override': runtimeConfig.ordererHostAlias,
          hostnameOverride: runtimeConfig.ordererHostAlias,
        },
      },
    },
  };
}

class FabricClient {
  constructor(options = {}) {
    this.gateway = new Gateway();
    this.network = null;
    this.contract = null;
    this.config = {
      ...config,
      ...options,
    };

    if (!this.config.peerHostAlias) {
      this.config.peerHostAlias = this.config.peerName;
    }

    if (!this.config.ordererHostAlias) {
      this.config.ordererHostAlias = 'orderer.example.com';
    }
  }

  async connect() {
    const identity = buildIdentity(this.config);
    const connectionProfile = buildConnectionProfile(this.config);

    await this.gateway.connect(connectionProfile, {
      identity,
      discovery: { enabled: true, asLocalhost: true },
    });

    this.network = await this.gateway.getNetwork(this.config.channelName);
    this.contract = this.network.getContract(this.config.chaincodeName);
  }

  async set(key, value) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    await this.contract.submitTransaction('Set', key, value);
    return { key, value };
  }

  async submit(functionName, ...args) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    return this.contract.submitTransaction(functionName, ...args.map(String));
  }

  async evaluate(functionName, ...args) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    return this.contract.evaluateTransaction(functionName, ...args.map(String));
  }

  async initSyncRound(round, expectedParticipants = 2) {
    return this.submit('AggregationContract:InitSyncRound', round, expectedParticipants);
  }

  async initCentralizedRound(round, expectedParticipants = 2) {
    return this.submit('AggregationContract:InitCentralizedRound', round, expectedParticipants);
  }

  async initHierarchicalRound(round, expectedOrgs, org1ExpectedNodes, org2ExpectedNodes) {
    return this.submit(
      'AggregationContract:InitHierarchicalRound',
      round,
      expectedOrgs,
      org1ExpectedNodes,
      org2ExpectedNodes
    );
  }

  async submitLocalNodeUpdateSync(collection, round, nodeID, updateData, sampleCount) {
    return this.submit(
      'AggregationContract:SubmitLocalNodeUpdateSync',
      collection,
      round,
      nodeID,
      updateData,
      sampleCount
    );
  }

  async finalizeOrgSyncRound(round) {
    return this.submit('AggregationContract:FinalizeOrgSyncRound', round);
  }

  async submitLocalUpdateSync(collection, round, updateData, sampleCount) {
    return this.submit(
      'AggregationContract:SubmitLocalUpdateSync',
      collection,
      round,
      updateData,
      sampleCount
    );
  }

  async submitLocalUpdateCentralized(collection, round, nodeID, updateData, sampleCount) {
    return this.submit(
      'AggregationContract:SubmitLocalUpdateCentralized',
      collection,
      round,
      nodeID,
      updateData,
      sampleCount
    );
  }

  async finalizeSyncRound(round) {
    return this.submit('AggregationContract:FinalizeSyncRound', round);
  }

  async finalizeCentralizedRound(round) {
    return this.submit('AggregationContract:FinalizeCentralizedRound', round);
  }

  async submitLocalUpdateAsync(collection, updateData, sampleCount, baselineVersion = 0) {
    const result = await this.submit(
      'AggregationContract:SubmitLocalUpdateAsync',
      collection,
      updateData,
      sampleCount,
      baselineVersion
    );
    return JSON.parse(result.toString());
  }

  async aggregateAsyncBatch(txIds, minUpdates = 5) {
    const result = await this.submit(
      'AggregationContract:AggregateAsyncBatch',
      JSON.stringify(txIds),
      minUpdates
    );
    return JSON.parse(result.toString());
  }

  async getPendingAsyncUpdates(limit = 0) {
    const result = await this.evaluate('AggregationContract:GetPendingAsyncUpdates', limit);
    return JSON.parse(result.toString());
  }

  async getGlobalModel(round) {
    const result = await this.evaluate('AggregationContract:GetGlobalModel', round);
    return JSON.parse(result.toString());
  }

  async getLatestModelVersion() {
    const result = await this.evaluate('AggregationContract:GetLatestModelVersion');
    return Number(result.toString());
  }

  async getGlobalModelByVersion(version) {
    const result = await this.evaluate('AggregationContract:GetGlobalModelByVersion', version);
    return JSON.parse(result.toString());
  }

  async getRoundStatus(round) {
    const result = await this.evaluate('AggregationContract:GetRoundStatus', round);
    return JSON.parse(result.toString());
  }

  async getSyncAggregationTiming(round) {
    const result = await this.evaluate('AggregationContract:GetSyncAggregationTiming', round);
    return JSON.parse(result.toString());
  }

  async getCentralizedAggregationTiming(round) {
    const result = await this.evaluate('AggregationContract:GetCentralizedAggregationTiming', round);
    return JSON.parse(result.toString());
  }

  async getAsyncAggregationTiming(version) {
    const result = await this.evaluate('AggregationContract:GetAsyncAggregationTiming', version);
    return JSON.parse(result.toString());
  }

  async getOrgRoundStatus(round, orgID) {
    const result = await this.evaluate('AggregationContract:GetOrgRoundStatus', round, orgID);
    return JSON.parse(result.toString());
  }

  async getCurrentRound() {
    const result = await this.evaluate('AggregationContract:GetCurrentRound');
    return Number(result.toString());
  }

  async get(key) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    const result = await this.contract.evaluateTransaction('Get', key);
    return result.toString();
  }

  async tryGet(key) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    try {
      const result = await this.contract.evaluateTransaction('Get', key);
      return result.toString();
    } catch (err) {
      if (err.message && err.message.includes('does not exist')) {
        return null;
      }
      throw err;
    }
  }

  async disconnect() {
    await this.gateway.disconnect();
  }
}

module.exports = FabricClient;
