const fs = require('fs');
const { fork } = require('child_process');
const path = require('path');

function toFixedNum(value) {
  return Number(value.toFixed(6));
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function validateWeights(weights) {
  if (!weights || typeof weights !== 'object') {
    throw new Error('Model snapshot is invalid: missing model object');
  }
  if (!Number.isFinite(weights.weight) || !Number.isFinite(weights.bias)) {
    throw new Error('Model snapshot is invalid: weight/bias must be finite numbers');
  }
}

function saveModelSnapshot(filePath, payload) {
  const resolvedPath = path.resolve(filePath);
  ensureParentDir(resolvedPath);
  fs.writeFileSync(resolvedPath, JSON.stringify(payload, null, 2), 'utf8');
  return resolvedPath;
}

function loadModelSnapshot(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Model snapshot not found: ${resolvedPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  validateWeights(parsed.model);

  return {
    filePath: resolvedPath,
    model: {
      weight: parsed.model.weight,
      bias: parsed.model.bias,
    },
    meta: parsed.meta || {},
  };
}

function createClientDataset(clientId, sampleSize) {
  const shift = clientId * 0.1;
  const xs = [];
  const ys = [];

  for (let i = 0; i < sampleSize; i += 1) {
    const x = -1 + (2 * i) / Math.max(sampleSize - 1, 1);
    const noise = Math.sin((i + 1) * (clientId + 3)) * 0.04;
    // True label rule with client-specific drift.
    const y = 2 * x + 1 + shift + noise;
    xs.push([x]);
    ys.push([y]);
  }

  return {
    xs,
    ys,
    sampleCount: sampleSize,
  };
}

function aggregateFedAvg(localModels) {
  const total = localModels.reduce((acc, model) => acc + model.sampleCount, 0);
  if (total === 0) {
    throw new Error('No local updates to aggregate');
  }

  return localModels.reduce(
    (acc, model) => {
      const factor = model.sampleCount / total;
      return {
        weight: acc.weight + model.weight * factor,
        bias: acc.bias + model.bias * factor,
      };
    },
    { weight: 0, bias: 0 }
  );
}

function evaluateMse(globalWeights, datasets) {
  let totalLoss = 0;
  let totalCount = 0;

  for (const dataset of datasets) {
    for (let i = 0; i < dataset.sampleCount; i += 1) {
      const x = dataset.xs[i][0];
      const y = dataset.ys[i][0];
      const prediction = globalWeights.weight * x + globalWeights.bias;
      const err = prediction - y;
      totalLoss += err * err;
      totalCount += 1;
    }
  }

  return totalCount > 0 ? totalLoss / totalCount : 0;
}

function createWorkerHandle(clientId, samplesPerClient) {
  const workerScript = path.join(__dirname, 'flClientWorker.js');
  const child = fork(workerScript, [], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  const pending = new Map();
  let sequence = 0;

  child.on('message', (message) => {
    const requestId = message?.requestId;
    if (!requestId || !pending.has(requestId)) {
      return;
    }

    const handler = pending.get(requestId);
    pending.delete(requestId);

    if (message.ok) {
      handler.resolve(message.payload);
      return;
    }

    handler.reject(new Error(message.error || `Worker ${clientId} error`));
  });

  child.on('exit', (code) => {
    const exitError = new Error(`Worker ${clientId} exited with code ${code}`);
    for (const handler of pending.values()) {
      handler.reject(exitError);
    }
    pending.clear();
  });

  function request(type, payload) {
    const requestId = `${clientId}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.send({ requestId, type, payload });
    });
  }

  return {
    child,
    init: () => request('init', { clientId, samples: samplesPerClient }),
    train: (payload) => request('train', payload),
    async shutdown() {
      if (!child.connected || child.killed) {
        return;
      }

      try {
        await request('shutdown', {});
      } catch (err) {
        // Ignore shutdown errors because process may have exited already.
      }

      if (!child.killed) {
        child.kill();
      }
    },
  };
}

async function runRoundWithWorkers(workers, payload) {
  const jobs = workers.map((worker) => worker.train(payload));
  return Promise.all(jobs);
}

function validateOptions(options) {
  const numericFields = ['rounds', 'clients', 'samples', 'localEpochs', 'batchSize', 'learningRate'];
  for (const field of numericFields) {
    if (!(options[field] > 0)) {
      throw new Error(`Invalid option: ${field} must be > 0`);
    }
  }
}

async function runSimpleFederatedLearning(opts) {
  const options = {
    rounds: opts.rounds ?? 5,
    clients: opts.clients ?? 3,
    samples: opts.samples ?? 20,
    localEpochs: opts.localEpochs ?? 3,
    batchSize: opts.batchSize ?? 8,
    learningRate: opts.learningRate ?? 0.03,
    processMode: 'multi-process',
    loadModelPath: opts.loadModelPath || null,
    saveModelPath: opts.saveModelPath || null,
  };

  validateOptions(options);

  const datasets = Array.from({ length: options.clients }, (_, idx) =>
    createClientDataset(idx, options.samples)
  );

  let globalWeights = { weight: 0, bias: 0 };
  let loadedModelInfo = null;
  if (options.loadModelPath) {
    loadedModelInfo = loadModelSnapshot(options.loadModelPath);
    globalWeights = {
      weight: loadedModelInfo.model.weight,
      bias: loadedModelInfo.model.bias,
    };
  }
  const rounds = [];
  const workers = Array.from({ length: options.clients }, (_, idx) =>
    createWorkerHandle(idx, options.samples)
  );

  try {
    await Promise.all(workers.map((worker) => worker.init()));

    for (let round = 1; round <= options.rounds; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const localUpdates = await runRoundWithWorkers(workers, {
        globalWeights,
        localEpochs: options.localEpochs,
        batchSize: options.batchSize,
        learningRate: options.learningRate,
      });

      globalWeights = aggregateFedAvg(localUpdates);
      const loss = evaluateMse(globalWeights, datasets);

      rounds.push({
        round,
        globalModel: {
          weight: toFixedNum(globalWeights.weight),
          bias: toFixedNum(globalWeights.bias),
        },
        mse: toFixedNum(loss),
        clientCount: options.clients,
        totalSamples: options.clients * options.samples,
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.shutdown()));
  }

  const result = {
    task: 'linear-regression-federated-learning',
    targetRule: 'y = 2x + 1 (with per-client drift + noise)',
    options,
    rounds,
    initialModel: {
      weight: toFixedNum(loadedModelInfo?.model.weight ?? 0),
      bias: toFixedNum(loadedModelInfo?.model.bias ?? 0),
    },
    loadedFrom: loadedModelInfo?.filePath || null,
    finalModel: rounds[rounds.length - 1]?.globalModel || { weight: 0, bias: 0 },
    finalMse: rounds[rounds.length - 1]?.mse || 0,
    timestamp: new Date().toISOString(),
  };

  if (options.saveModelPath) {
    result.savedTo = saveModelSnapshot(options.saveModelPath, {
      task: result.task,
      model: {
        weight: result.finalModel.weight,
        bias: result.finalModel.bias,
      },
      metrics: {
        finalMse: result.finalMse,
        rounds: result.rounds.length,
      },
      meta: {
        targetRule: result.targetRule,
        timestamp: new Date().toISOString(),
      },
    });
  }

  return result;
}

module.exports = { runSimpleFederatedLearning };
