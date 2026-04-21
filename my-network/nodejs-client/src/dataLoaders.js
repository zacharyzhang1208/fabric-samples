/**
 * Pluggable Data Loaders Framework
 * Supports different datasets: linear, mnist, cifar
 * Each loader implements: load(), buildModel(), serialize/deserialize methods
 */

const fs = require('fs');
const path = require('path');

// Suppress TensorFlow C++ INFO logs (oneDNN/CPU feature banners).
if (!process.env.TF_CPP_MIN_LOG_LEVEL) {
  process.env.TF_CPP_MIN_LOG_LEVEL = '2';
}

const tf = require('@tensorflow/tfjs-node');
const MNISTFileLoader = require('./mnistFileLoader');
const CIFARFileLoader = require('./cifarFileLoader');

/**
 * Base DataLoader class - defines the interface
 */
class DataLoader {
  async load() {
    throw new Error('load() must be implemented');
  }

  buildModel() {
    throw new Error('buildModel() must be implemented');
  }

  serializeModelUpdate(model) {
    throw new Error('serializeModelUpdate() must be implemented');
  }

  deserializeGlobalModel(weightsJson, model) {
    throw new Error('deserializeGlobalModel() must be implemented');
  }
}

/**
 * Linear Regression Loader
 * Loads pre-generated data from src/utils/generateLinearFitData.js
 */
class LinearRegressionLoader extends DataLoader {
  constructor(clientId) {
    super();
    this.clientId = clientId;
  }

  async load() {
    const dataPath = path.join(__dirname, '..', 'data', 'linear-fit', `${this.clientId}.json`);
    
    if (!fs.existsSync(dataPath)) {
      throw new Error(
        `Linear fit dataset file missing: ${this.clientId}.json\n` +
        `Please run: node src/utils/generateLinearFitData.js`
      );
    }
    
    const raw = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(raw);
    
    if (!Array.isArray(data.xs) || !Array.isArray(data.ys)) {
      throw new Error(`Invalid linear fit dataset format: ${dataPath}`);
    }

    return {
      xs: tf.tensor1d(data.xs),
      ys: tf.tensor1d(data.ys),
      sampleCount: data.sampleCount,
    };
  }

  buildModel() {
    const model = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [1],
          units: 1,
          activation: 'linear',
        }),
      ],
    });

    model.compile({
      optimizer: tf.train.sgd(0.03),
      loss: 'meanSquaredError',
    });

    return model;
  }

  serializeModelUpdate(model) {
    const weights = model.getWeights();
    return {
      weights: weights.map((w) => Array.from(w.dataSync())),
      shapes: weights.map((w) => w.shape),
    };
  }

  deserializeGlobalModel(weightsJson, model) {
    const weights = weightsJson.weights.map((w, i) => tf.tensor(w, weightsJson.shapes[i]));
    model.setWeights(weights);
  }
}

/**
 * MNIST CNN Loader
 * Requires pre-downloaded MNIST data via src/utils/downloadMNIST.js
 */
class MNISTLoader extends DataLoader {
  constructor(clientId, options = {}) {
    super();
    this.clientId = clientId;
    this.trainSamples = Number.isInteger(options.trainSamples) && options.trainSamples > 0
      ? options.trainSamples
      : 20000;
    this.totalNodes = Number.isInteger(options.totalNodes) && options.totalNodes > 0
      ? options.totalNodes
      : 5;
    this.nodeIndex = Number.isInteger(options.nodeIndex) && options.nodeIndex >= 0
      ? options.nodeIndex
      : null;
  }

  async load() {
    const mnistLoader = new MNISTFileLoader();
    
    console.log(`[${this.clientId}] Loading MNIST dataset...`);
    const { images, labels } = await mnistLoader.loadTrainingData(this.trainSamples);

    // Partition based on a global node index so org-local node IDs do not overlap.
    const fallbackNodeIndex = parseInt(this.clientId.split('-N')[1], 10) - 1;
    const nodeIndex = this.nodeIndex !== null ? this.nodeIndex : fallbackNodeIndex;
    const samplesPerNode = Math.floor(images.length / this.totalNodes);
    const startIdx = nodeIndex * samplesPerNode;
    const endIdx = nodeIndex === this.totalNodes - 1 ? images.length : (nodeIndex + 1) * samplesPerNode;

    const nodeImages = images.slice(startIdx, endIdx);
    const nodeLabels = labels.slice(startIdx, endIdx);

    return {
      images: nodeImages,
      labels: nodeLabels,
      sampleCount: nodeImages.length,
    };
  }

  buildModel() {
    const model = tf.sequential({
      layers: [
        tf.layers.conv2d({
          inputShape: [28, 28, 1],
          kernelSize: 5,
          filters: 32,
          activation: 'relu',
        }),
        tf.layers.maxPooling2d({
          poolSize: 2,
        }),
        tf.layers.conv2d({
          kernelSize: 5,
          filters: 64,
          activation: 'relu',
        }),
        tf.layers.maxPooling2d({
          poolSize: 2,
        }),
        tf.layers.flatten(),
        tf.layers.dense({
          units: 128,
          activation: 'relu',
        }),
        tf.layers.dropout({
          rate: 0.2,
        }),
        tf.layers.dense({
          units: 10,
          activation: 'softmax',
        }),
      ],
    });

    model.compile({
      optimizer: tf.train.momentum(0.01, 0.9),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });

    return model;
  }

  serializeModelUpdate(model) {
    // Flatten all weights into a single 1D array for chaincode compatibility
    const weights = model.getWeights();
    let flatWeights = [];
    
    for (const w of weights) {
      flatWeights = flatWeights.concat(Array.from(w.dataSync()));
    }
    
    return flatWeights;
  }

  deserializeGlobalModel(weightsArray, model) {
    // Unflatten 1D array back to tensors using current model shapes
    if (!Array.isArray(weightsArray)) {
      console.error('deserializeGlobalModel expects array, got:', typeof weightsArray);
      return;
    }
    
    const currentWeights = model.getWeights();
    const shapes = currentWeights.map(w => w.shape);
    const newWeights = [];
    
    let offset = 0;
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      const size = shape.reduce((a, b) => a * b, 1);
      const slice = weightsArray.slice(offset, offset + size);
      newWeights.push(tf.tensor(slice, shape));
      offset += size;
    }
    
    model.setWeights(newWeights);
  }
}

/**
 * CIFAR-10 CNN Loader
 * Requires pre-downloaded CIFAR-10 data via src/utils/downloadCIFAR.js
 */
class CIFARLoader extends DataLoader {
  constructor(clientId, options = {}) {
    super();
    this.clientId = clientId;
    this.trainSamples = Number.isInteger(options.trainSamples) && options.trainSamples > 0
      ? options.trainSamples
      : 20000;
    this.totalNodes = Number.isInteger(options.totalNodes) && options.totalNodes > 0
      ? options.totalNodes
      : 5;
    this.nodeIndex = Number.isInteger(options.nodeIndex) && options.nodeIndex >= 0
      ? options.nodeIndex
      : null;
  }

  async load() {
    const cifarLoader = new CIFARFileLoader();

    console.log(`[${this.clientId}] Loading CIFAR-10 dataset...`);
    const { images, labels } = await cifarLoader.loadTrainingData(this.trainSamples);

    const fallbackNodeIndex = parseInt(this.clientId.split('-N')[1], 10) - 1;
    const nodeIndex = this.nodeIndex !== null ? this.nodeIndex : fallbackNodeIndex;
    const samplesPerNode = Math.floor(images.length / this.totalNodes);
    const startIdx = nodeIndex * samplesPerNode;
    const endIdx = nodeIndex === this.totalNodes - 1 ? images.length : (nodeIndex + 1) * samplesPerNode;

    const nodeImages = images.slice(startIdx, endIdx);
    const nodeLabels = labels.slice(startIdx, endIdx);

    return {
      images: nodeImages,
      labels: nodeLabels,
      sampleCount: nodeImages.length,
    };
  }

  buildModel() {
    const model = tf.sequential({
      layers: [
        tf.layers.conv2d({
          inputShape: [32, 32, 3],
          kernelSize: 3,
          filters: 32,
          activation: 'relu',
          padding: 'same',
        }),
        tf.layers.maxPooling2d({ poolSize: 2 }),
        tf.layers.conv2d({
          kernelSize: 3,
          filters: 64,
          activation: 'relu',
          padding: 'same',
        }),
        tf.layers.maxPooling2d({ poolSize: 2 }),
        tf.layers.flatten(),
        tf.layers.dense({ units: 128, activation: 'relu' }),
        tf.layers.dropout({ rate: 0.3 }),
        tf.layers.dense({ units: 10, activation: 'softmax' }),
      ],
    });

    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });

    return model;
  }

  serializeModelUpdate(model) {
    const weights = model.getWeights();
    let flatWeights = [];

    for (const w of weights) {
      flatWeights = flatWeights.concat(Array.from(w.dataSync()));
    }

    return flatWeights;
  }

  deserializeGlobalModel(weightsArray, model) {
    if (!Array.isArray(weightsArray)) {
      console.error('deserializeGlobalModel expects array, got:', typeof weightsArray);
      return;
    }

    const currentWeights = model.getWeights();
    const shapes = currentWeights.map((w) => w.shape);
    const newWeights = [];

    let offset = 0;
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      const size = shape.reduce((a, b) => a * b, 1);
      const slice = weightsArray.slice(offset, offset + size);
      newWeights.push(tf.tensor(slice, shape));
      offset += size;
    }

    model.setWeights(newWeights);
  }
}

/**
 * Data Loader Factory
 */
class DataLoaderFactory {
  static create(datasetName, clientId = 'A-N1', options = {}) {
    switch (datasetName) {
      case 'linear':
        return new LinearRegressionLoader(clientId);
      case 'mnist':
        return new MNISTLoader(clientId, options);
      case 'cifar':
        return new CIFARLoader(clientId, options);
      default:
        throw new Error(`Unknown dataset: ${datasetName}`);
    }
  }

  static getAvailable() {
    return ['linear', 'mnist', 'cifar'];
  }
}

module.exports = {
  DataLoader,
  LinearRegressionLoader,
  MNISTLoader,
  CIFARLoader,
  DataLoaderFactory,
};
