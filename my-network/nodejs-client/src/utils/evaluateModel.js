#!/usr/bin/env node

/**
 * Evaluate saved FL global models.
 *
 * Usage:
 *   node src/utils/evaluateModel.js [dataset] [round|latest] [maxSamples]
 *
 * Examples:
 *   node src/utils/evaluateModel.js linear latest
 *   node src/utils/evaluateModel.js simple 3
 *   node src/utils/evaluateModel.js mnist latest 2000
 */

const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const { DataLoaderFactory, MNISTLoader } = require('../dataLoaders');
const MNISTFileLoader = require('../mnistFileLoader');

function parseArgs() {
  const dataset = (process.argv[2] || 'simple').toLowerCase();
  const roundArg = (process.argv[3] || 'latest').toLowerCase();
  const maxSamplesArg = process.argv[4];

  const maxSamples = maxSamplesArg ? Number(maxSamplesArg) : undefined;
  if (maxSamplesArg && (!Number.isFinite(maxSamples) || maxSamples <= 0)) {
    throw new Error(`Invalid maxSamples: ${maxSamplesArg}`);
  }

  return { dataset, roundArg, maxSamples };
}

function resolveModelFile(dataset, roundArg) {
  const modelsDir = path.join(__dirname, '..', '..', 'models', dataset);

  if (!fs.existsSync(modelsDir)) {
    throw new Error(`Models directory not found: ${modelsDir}`);
  }

  if (roundArg === 'latest') {
    const latestPath = path.join(modelsDir, 'global-model-latest.json');
    if (!fs.existsSync(latestPath)) {
      throw new Error(`Latest model file not found: ${latestPath}`);
    }
    return latestPath;
  }

  const round = Number(roundArg);
  if (!Number.isInteger(round) || round <= 0) {
    throw new Error(`Invalid round: ${roundArg}. Use positive integer or 'latest'.`);
  }

  const roundPath = path.join(modelsDir, `global-model-round-${round}.json`);
  if (!fs.existsSync(roundPath)) {
    throw new Error(`Model file not found: ${roundPath}`);
  }
  return roundPath;
}

function loadModelRecord(modelPath) {
  const raw = fs.readFileSync(modelPath, 'utf8');
  const record = JSON.parse(raw);
  if (!record || typeof record.modelData !== 'string') {
    throw new Error(`Invalid model file format: ${modelPath}`);
  }
  return record;
}

function computeLinearMetrics(xs, ys, w, b) {
  const preds = xs.map((x) => w * x + b);
  const n = xs.length;

  let mse = 0;
  let mae = 0;
  let sumY = 0;

  for (let i = 0; i < n; i++) {
    const err = preds[i] - ys[i];
    mse += err * err;
    mae += Math.abs(err);
    sumY += ys[i];
  }

  mse /= n;
  mae /= n;

  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const diffMean = ys[i] - meanY;
    const diffPred = ys[i] - preds[i];
    ssTot += diffMean * diffMean;
    ssRes += diffPred * diffPred;
  }

  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { mse, mae, r2, sampleCount: n };
}

function evaluateLinearDataset(modelWeights) {
  if (!Array.isArray(modelWeights) || modelWeights.length < 2) {
    throw new Error('Linear modelData must be [w, b]');
  }

  const w = Number(modelWeights[0]);
  const b = Number(modelWeights[1]);

  if (!Number.isFinite(w) || !Number.isFinite(b)) {
    throw new Error('Linear model parameters are not finite numbers');
  }

  const simpleDir = path.join(__dirname, '..', '..', 'data', 'simple');
  if (!fs.existsSync(simpleDir)) {
    throw new Error(
      `Simple dataset directory not found: ${simpleDir}\n` +
      'Please run: node src/utils/generateSimpleData.js'
    );
  }

  const files = fs.readdirSync(simpleDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(
      `No simple data files found in: ${simpleDir}\n` +
      'Please run: node src/utils/generateSimpleData.js'
    );
  }

  const perClient = [];
  const allXs = [];
  const allYs = [];

  for (const file of files) {
    const fullPath = path.join(simpleDir, file);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const data = JSON.parse(raw);
    const xs = data.xs || [];
    const ys = data.ys || [];

    if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length === 0) {
      continue;
    }

    const metrics = computeLinearMetrics(xs, ys, w, b);
    perClient.push({
      client: path.basename(file, '.json'),
      ...metrics,
    });

    allXs.push(...xs);
    allYs.push(...ys);
  }

  if (allXs.length === 0) {
    throw new Error('No valid simple samples found for evaluation');
  }

  const overall = computeLinearMetrics(allXs, allYs, w, b);

  return {
    task: 'regression',
    parameters: { w, b },
    overall,
    perClient,
  };
}

async function evaluateMnistDataset(modelWeights, maxSamples) {
  if (!Array.isArray(modelWeights)) {
    throw new Error('MNIST modelData must be a flattened float array');
  }

  const loader = new MNISTLoader('EVAL');
  const model = loader.buildModel();

  try {
    loader.deserializeGlobalModel(modelWeights, model);

    const mnistLoader = new MNISTFileLoader();
    const sampleLimit = maxSamples || 2000;
    const { images, labels } = await mnistLoader.loadTestData(sampleLimit);

    const imageData = [];
    for (const img of images) {
      imageData.push(...img);
    }

    const xs = tf.tensor4d(imageData, [images.length, 28, 28, 1]);
    const ys = tf.tensor2d(labels);

    const evalResult = model.evaluate(xs, ys, { batchSize: 64, verbose: 0 });

    let loss;
    let acc;
    if (Array.isArray(evalResult)) {
      loss = evalResult[0].dataSync()[0];
      acc = evalResult[1] ? evalResult[1].dataSync()[0] : undefined;
      evalResult.forEach((t) => t.dispose());
    } else {
      loss = evalResult.dataSync()[0];
      evalResult.dispose();
    }

    xs.dispose();
    ys.dispose();

    return {
      task: 'classification',
      overall: {
        loss,
        accuracy: acc,
        sampleCount: images.length,
      },
    };
  } finally {
    model.dispose();
  }
}

function saveEvaluationResult(dataset, modelPath, modelRecord, result) {
  const reportsDir = path.join(__dirname, '..', '..', 'reports', 'evaluations');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const roundPart = modelRecord.round ? `round-${modelRecord.round}` : 'latest';
  const outputPath = path.join(reportsDir, `evaluation-${dataset}-${roundPart}.json`);

  const payload = {
    dataset,
    modelFile: modelPath,
    round: modelRecord.round,
    timestamp: new Date().toISOString(),
    result,
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  return outputPath;
}

async function main() {
  const { dataset, roundArg, maxSamples } = parseArgs();

  if (!DataLoaderFactory.getAvailable().includes(dataset)) {
    throw new Error(
      `Unsupported dataset: ${dataset}. Supported: ${DataLoaderFactory.getAvailable().join(', ')}`
    );
  }

  const modelPath = resolveModelFile(dataset, roundArg);
  const modelRecord = loadModelRecord(modelPath);
  const modelWeights = JSON.parse(modelRecord.modelData);

  console.log(`Evaluating dataset: ${dataset}`);
  console.log(`Model file: ${modelPath}`);

  let result;
  if (dataset === 'mnist') {
    result = await evaluateMnistDataset(modelWeights, maxSamples);
    console.log(
      `MNIST metrics -> loss=${result.overall.loss.toFixed(6)}, ` +
      `accuracy=${(result.overall.accuracy * 100).toFixed(2)}%, samples=${result.overall.sampleCount}`
    );
  } else {
    result = evaluateLinearDataset(modelWeights);
    console.log(
      `Linear metrics -> MSE=${result.overall.mse.toFixed(6)}, ` +
      `MAE=${result.overall.mae.toFixed(6)}, R2=${result.overall.r2.toFixed(6)}, ` +
      `samples=${result.overall.sampleCount}`
    );
  }

  const outputPath = saveEvaluationResult(dataset, modelPath, modelRecord, result);
  console.log(`Evaluation saved: ${outputPath}`);
}

main().catch((err) => {
  console.error(`Evaluation failed: ${err.message}`);
  process.exit(1);
});
