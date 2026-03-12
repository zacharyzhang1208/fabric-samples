#!/usr/bin/env node

/**
 * Evaluate saved FL global models.
 *
 * Usage:
 *   node src/utils/evaluateModel.js [dataset] [round|latest] [maxSamples]
 *
 * Examples:
 *   node src/utils/evaluateModel.js
 *   node src/utils/evaluateModel.js linear latest
 *   node src/utils/evaluateModel.js linear 3
 *   node src/utils/evaluateModel.js mnist latest 2000
 */

const fs = require('fs');
const path = require('path');

// Suppress TensorFlow C++ INFO logs (oneDNN/CPU feature banners).
if (!process.env.TF_CPP_MIN_LOG_LEVEL) {
  process.env.TF_CPP_MIN_LOG_LEVEL = '2';
}

const tf = require('@tensorflow/tfjs-node');
const { DataLoaderFactory, MNISTLoader } = require('../dataLoaders');
const MNISTFileLoader = require('../mnistFileLoader');

function parseArgs() {
  const datasetArg = process.argv[2] ? process.argv[2].toLowerCase() : null;
  const dataset = datasetArg === 'all' ? null : datasetArg;
  const roundArg = process.argv[3] ? process.argv[3].toLowerCase() : null;
  const maxSamplesArg = process.argv[4];

  const maxSamples = maxSamplesArg ? Number(maxSamplesArg) : undefined;
  if (maxSamplesArg && (!Number.isFinite(maxSamples) || maxSamples <= 0)) {
    throw new Error(`Invalid maxSamples: ${maxSamplesArg}`);
  }

  return { dataset, roundArg, maxSamples };
}

function resolveDatasets(datasetArg) {
  const available = DataLoaderFactory.getAvailable();

  if (datasetArg) {
    if (!available.includes(datasetArg)) {
      throw new Error(
        `Unsupported dataset: ${datasetArg}. Supported: ${available.join(', ')}`
      );
    }
    return [datasetArg];
  }

  // No dataset argument: evaluate every dataset that has saved model rounds.
  const modelRoot = path.join(__dirname, '..', '..', 'models');
  const datasetsWithModels = available.filter((dataset) => {
    const modelsDir = path.join(modelRoot, dataset);
    if (!fs.existsSync(modelsDir)) return false;
    return fs.readdirSync(modelsDir).some((f) => /^global-model-round-\d+\.json$/.test(f));
  });

  if (datasetsWithModels.length === 0) {
    throw new Error(`No model rounds found under: ${modelRoot}`);
  }

  return datasetsWithModels;
}

function resolveModelFiles(dataset, roundArg) {
  const modelsDir = path.join(__dirname, '..', '..', 'models', dataset);

  if (!fs.existsSync(modelsDir)) {
    throw new Error(`Models directory not found: ${modelsDir}`);
  }

  // If round is omitted or explicitly set to "all", evaluate all saved rounds.
  if (!roundArg || roundArg === 'all') {
    const roundFiles = fs
      .readdirSync(modelsDir)
      .filter((f) => /^global-model-round-\d+\.json$/.test(f))
      .sort((a, b) => {
        const ra = Number(a.match(/\d+/)[0]);
        const rb = Number(b.match(/\d+/)[0]);
        return ra - rb;
      })
      .map((f) => path.join(modelsDir, f));

    if (roundFiles.length === 0) {
      throw new Error(`No round model files found in: ${modelsDir}`);
    }

    return roundFiles;
  }

  if (roundArg === 'latest') {
    const latestPath = path.join(modelsDir, 'global-model-latest.json');
    if (!fs.existsSync(latestPath)) {
      throw new Error(`Latest model file not found: ${latestPath}`);
    }
    return [latestPath];
  }

  const round = Number(roundArg);
  if (!Number.isInteger(round) || round <= 0) {
    throw new Error(`Invalid round: ${roundArg}. Use positive integer, 'latest', or 'all'.`);
  }

  const roundPath = path.join(modelsDir, `global-model-round-${round}.json`);
  if (!fs.existsSync(roundPath)) {
    throw new Error(`Model file not found: ${roundPath}`);
  }
  return [roundPath];
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

  const linearFitDir = path.join(__dirname, '..', '..', 'data', 'linear-fit');
  if (!fs.existsSync(linearFitDir)) {
    throw new Error(
      `Linear fit dataset directory not found: ${linearFitDir}\n` +
      'Please run: node src/utils/generateLinearFitData.js'
    );
  }

  const files = fs.readdirSync(linearFitDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(
      `No linear fit data files found in: ${linearFitDir}\n` +
      'Please run: node src/utils/generateLinearFitData.js'
    );
  }

  const perClient = [];
  const allXs = [];
  const allYs = [];

  for (const file of files) {
    const fullPath = path.join(linearFitDir, file);
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
    throw new Error('No valid linear fit samples found for evaluation');
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

    // 1. Standard metrics (loss + accuracy)
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

    // 2. Per-class Precision / Recall / F1
    const NUM_CLASSES = 10;
    const predsTensor = model.predict(xs);
    const predLabels = tf.argMax(predsTensor, 1).dataSync();
    const trueLabels = tf.argMax(ys, 1).dataSync();
    predsTensor.dispose();

    const tp = new Array(NUM_CLASSES).fill(0);
    const fp = new Array(NUM_CLASSES).fill(0);
    const fn = new Array(NUM_CLASSES).fill(0);
    for (let i = 0; i < trueLabels.length; i++) {
      const pred = predLabels[i];
      const true_ = trueLabels[i];
      if (pred === true_) {
        tp[true_]++;
      } else {
        fp[pred]++;
        fn[true_]++;
      }
    }

    const perClass = [];
    let macroP = 0;
    let macroR = 0;
    let macroF1 = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const precision = tp[c] + fp[c] > 0 ? tp[c] / (tp[c] + fp[c]) : 0;
      const recall    = tp[c] + fn[c] > 0 ? tp[c] / (tp[c] + fn[c]) : 0;
      const f1        = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
      perClass.push({ class: c, precision, recall, f1, support: tp[c] + fn[c] });
      macroP  += precision;
      macroR  += recall;
      macroF1 += f1;
    }
    const macroAvg = {
      precision: macroP  / NUM_CLASSES,
      recall:    macroR  / NUM_CLASSES,
      f1:        macroF1 / NUM_CLASSES,
    };

    xs.dispose();
    ys.dispose();

    return {
      task: 'classification',
      overall: {
        loss,
        accuracy: acc,
        sampleCount: images.length,
        ...macroAvg,
      },
      macroAvg,
      perClass,
    };
  } finally {
    model.dispose();
  }
}

function saveEvaluationResult(dataset, modelPath, modelRecord, result) {
  const reportsRoot = path.join(__dirname, '..', '..', 'reports', 'evaluations');
  const reportsDir = path.join(reportsRoot, dataset);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const roundPart = modelRecord.round ? `round-${modelRecord.round}` : 'latest';
  const outputPath = path.join(reportsDir, `evaluation-${roundPart}.json`);

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
  const evaluatingAllRounds = !roundArg || roundArg === 'all';

  const datasets = resolveDatasets(dataset);
  if (!dataset) {
    console.log(`No dataset argument provided, evaluating all datasets with model rounds: ${datasets.join(', ')}`);
  }

  for (const currentDataset of datasets) {
    const modelPaths = resolveModelFiles(currentDataset, roundArg);

    console.log(`Evaluating dataset: ${currentDataset}`);
    if (evaluatingAllRounds) {
      console.log(`Mode: all rounds (${modelPaths.length} files)`);
    }

    for (const modelPath of modelPaths) {
      const modelRecord = loadModelRecord(modelPath);
      const modelWeights = JSON.parse(modelRecord.modelData);

      console.log(`Model file: ${modelPath}`);

      let result;
      if (currentDataset === 'mnist') {
        result = await evaluateMnistDataset(modelWeights, maxSamples);
        console.log(
          `MNIST metrics -> loss=${result.overall.loss.toFixed(6)}, ` +
          `accuracy=${(result.overall.accuracy * 100).toFixed(2)}%` +
          (result.overall.f1 !== undefined
            ? `, precision=${(result.overall.precision * 100).toFixed(2)}%` +
              `, recall=${(result.overall.recall * 100).toFixed(2)}%` +
              `, F1=${(result.overall.f1 * 100).toFixed(2)}%`
            : '') +
          `, samples=${result.overall.sampleCount}`
        );
      } else {
        result = evaluateLinearDataset(modelWeights);
        console.log(
          `Linear metrics -> MSE=${result.overall.mse.toFixed(6)}, ` +
          `MAE=${result.overall.mae.toFixed(6)}, R2=${result.overall.r2.toFixed(6)}, ` +
          `samples=${result.overall.sampleCount}`
        );
      }

      const outputPath = saveEvaluationResult(currentDataset, modelPath, modelRecord, result);
      console.log(`Evaluation saved: ${outputPath}`);
    }
  }
}

main().catch((err) => {
  console.error(`Evaluation failed: ${err.message}`);
  process.exit(1);
});
