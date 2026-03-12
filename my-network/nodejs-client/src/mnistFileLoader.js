/**
 * Local MNIST Data Loader
 * Loads MNIST dataset that was pre-downloaded using src/utils/downloadMNIST.js
 * No external dependencies - uses only Node.js built-in modules
 * 
 * Pre-requisite: Run `node src/utils/downloadMNIST.js` to download data first
 */

const fs = require('fs');
const path = require('path');

// Suppress TensorFlow C++ INFO logs (oneDNN/CPU feature banners).
if (!process.env.TF_CPP_MIN_LOG_LEVEL) {
  process.env.TF_CPP_MIN_LOG_LEVEL = '2';
}

const tf = require('@tensorflow/tfjs-node');

class MNISTFileLoader {
  constructor(dataDir = path.join(__dirname, '..', 'data', 'mnist')) {
    this.dataDir = dataDir;
    this.trainingDataPath = path.join(dataDir, 'train-images-idx3-ubyte');
    this.trainingLabelsPath = path.join(dataDir, 'train-labels-idx1-ubyte');
    this.testDataPath = path.join(dataDir, 't10k-images-idx3-ubyte');
    this.testLabelsPath = path.join(dataDir, 't10k-labels-idx1-ubyte');
  }

  /**
   * Check if all required MNIST files exist locally
   */
  checkDataAvailable() {
    const requiredFiles = [
      this.trainingDataPath,
      this.trainingLabelsPath,
      this.testDataPath,
      this.testLabelsPath
    ];

    for (const file of requiredFiles) {
      if (!fs.existsSync(file)) {
        throw new Error(
          `MNIST data file missing: ${path.basename(file)}\n` +
          `Please run: node src/utils/downloadMNIST.js`
        );
      }
    }
  }

  /**
   * Parse MNIST image file
   * Format: magic number (4 bytes) + num_images (4 bytes) + num_rows (4 bytes) + num_cols (4 bytes) + image data
   */
  parseImageFile(filePath, maxSamples = Infinity) {
    const buffer = fs.readFileSync(filePath);
    let offset = 16; // Skip magic number (4) + count (4) + rows (4) + cols (4)
    
    const numImages = buffer.readUInt32BE(4);
    const numSamples = Math.min(maxSamples, numImages);
    const imageSize = 28 * 28;
    
    const images = [];
    for (let i = 0; i < numSamples; i++) {
      const image = new Uint8Array(imageSize);
      for (let j = 0; j < imageSize; j++) {
        image[j] = buffer[offset++] / 255; // Normalize to [0, 1]
      }
      images.push(Array.from(image));
    }
    
    return images;
  }

  /**
   * Parse MNIST label file
   * Format: magic number (4 bytes) + num_labels (4 bytes) + label data
   */
  parseLabelFile(filePath, maxSamples = Infinity) {
    const buffer = fs.readFileSync(filePath);
    let offset = 8; // Skip magic number (4) + count (4)
    
    const numLabels = buffer.readUInt32BE(4);
    const numSamples = Math.min(maxSamples, numLabels);
    
    const labels = [];
    for (let i = 0; i < numSamples; i++) {
      const label = buffer[offset++];
      // Convert to one-hot encoding
      const oneHot = new Array(10).fill(0);
      oneHot[label] = 1;
      labels.push(oneHot);
    }
    
    return labels;
  }

  /**
   * Load training data
   */
  async loadTrainingData(maxSamples = 60000) {
    this.checkDataAvailable();
    
    console.log(`Loading training data (max ${maxSamples} samples)...`);
    const images = this.parseImageFile(this.trainingDataPath, maxSamples);
    const labels = this.parseLabelFile(this.trainingLabelsPath, maxSamples);
    
    return { images, labels };
  }

  /**
   * Load test data
   */
  async loadTestData(maxSamples = 10000) {
    this.checkDataAvailable();
    
    console.log(`Loading test data (max ${maxSamples} samples)...`);
    const images = this.parseImageFile(this.testDataPath, maxSamples);
    const labels = this.parseLabelFile(this.testLabelsPath, maxSamples);
    
    return { images, labels };
  }
}

// Static cache to prevent reloading across multiple client instances
MNISTFileLoader.cachedData = null;

module.exports = MNISTFileLoader;
