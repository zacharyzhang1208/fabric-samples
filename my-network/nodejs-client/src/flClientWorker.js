const tf = require('@tensorflow/tfjs');

let clientId = null;
let dataset = null;

function createLinearModel(learningRate) {
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 1, inputShape: [1], useBias: true }));
  model.compile({
    optimizer: tf.train.sgd(learningRate),
    loss: 'meanSquaredError',
  });
  return model;
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
  return {
    weight: kernel.arraySync()[0][0],
    bias: bias.arraySync()[0],
  };
}

function createClientDataset(id, sampleSize) {
  const shift = id * 0.1;
  const xs = [];
  const ys = [];

  for (let i = 0; i < sampleSize; i += 1) {
    const x = -1 + (2 * i) / Math.max(sampleSize - 1, 1);
    const noise = Math.sin((i + 1) * (id + 3)) * 0.04;
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

async function train(payload) {
  if (!dataset) {
    throw new Error('Worker dataset not initialized');
  }

  const model = createLinearModel(payload.learningRate);
  setModelWeights(model, payload.globalWeights);

  await model.fit(dataset.xs, dataset.ys, {
    epochs: payload.localEpochs,
    batchSize: payload.batchSize,
    shuffle: true,
    verbose: 0,
  });

  const weights = getModelWeights(model);
  model.dispose();

  return {
    ...weights,
    sampleCount: dataset.sampleCount,
    clientId,
  };
}

function handleInit(payload) {
  if (dataset) {
    dataset.xs.dispose();
    dataset.ys.dispose();
  }

  clientId = payload.clientId;
  dataset = createClientDataset(clientId, payload.samples);

  return {
    clientId,
    sampleCount: dataset.sampleCount,
  };
}

function cleanup() {
  if (dataset) {
    dataset.xs.dispose();
    dataset.ys.dispose();
    dataset = null;
  }
}

function respondOk(requestId, payload) {
  process.send({ requestId, ok: true, payload });
}

function respondError(requestId, err) {
  process.send({
    requestId,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}

process.on('message', async (message) => {
  const { requestId, type, payload } = message || {};

  try {
    if (type === 'init') {
      respondOk(requestId, handleInit(payload));
      return;
    }

    if (type === 'train') {
      const result = await train(payload);
      respondOk(requestId, result);
      return;
    }

    if (type === 'shutdown') {
      cleanup();
      respondOk(requestId, { clientId });
      setImmediate(() => process.exit(0));
      return;
    }

    throw new Error(`Unsupported worker message type: ${type}`);
  } catch (err) {
    respondError(requestId, err);
  }
});

process.on('exit', cleanup);
