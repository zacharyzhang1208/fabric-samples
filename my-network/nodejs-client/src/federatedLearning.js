const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');

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

function createLinearModel(learningRate) {
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 1, inputShape: [1], useBias: true }));
  model.compile({
    optimizer: tf.train.sgd(learningRate),
    loss: 'meanSquaredError',
  });
  return model;
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
    xs: tf.tensor2d(xs),
    ys: tf.tensor2d(ys),
    sampleCount: sampleSize,
  };
}

function setModelWeights(model, weights) {
  const kernel = tf.tensor2d([[weights.weight]]);
  const bias = tf.tensor1d([weights.bias]);
  model.setWeights([kernel, bias]);
  kernel.dispose();
  bias.dispose();
}

function getModelWeights(model) {
  const [kernel, bias] = model.getWeights();
  const weight = kernel.arraySync()[0][0];
  const biasValue = bias.arraySync()[0];
  return { weight, bias: biasValue };
}

async function trainLocalModel(globalWeights, dataset, options) {
  const model = createLinearModel(options.learningRate);
  setModelWeights(model, globalWeights);

  await model.fit(dataset.xs, dataset.ys, {
    epochs: options.localEpochs,
    batchSize: options.batchSize,
    shuffle: true,
    verbose: 0,
  });

  const localWeights = getModelWeights(model);
  model.dispose();

  return {
    ...localWeights,
    sampleCount: dataset.sampleCount,
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

async function evaluateMse(globalWeights, datasets) {
  const model = createLinearModel(0.01);
  setModelWeights(model, globalWeights);

  const mergedXs = tf.concat(datasets.map((dataset) => dataset.xs), 0);
  const mergedYs = tf.concat(datasets.map((dataset) => dataset.ys), 0);

  const prediction = model.predict(mergedXs);
  const mseTensor = tf.losses.meanSquaredError(mergedYs, prediction).mean();
  const mseValue = (await mseTensor.data())[0];

  mergedXs.dispose();
  mergedYs.dispose();
  prediction.dispose();
  mseTensor.dispose();
  model.dispose();

  return mseValue;
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

  for (let round = 1; round <= options.rounds; round += 1) {
    const localUpdates = [];
    for (const dataset of datasets) {
      // Train local model from the same global initialization.
      // eslint-disable-next-line no-await-in-loop
      const update = await trainLocalModel(globalWeights, dataset, options);
      localUpdates.push(update);
    }

    globalWeights = aggregateFedAvg(localUpdates);
    // eslint-disable-next-line no-await-in-loop
    const loss = await evaluateMse(globalWeights, datasets);

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

  for (const dataset of datasets) {
    dataset.xs.dispose();
    dataset.ys.dispose();
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
