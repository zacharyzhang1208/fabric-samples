/**
 * Local CIFAR-10 Data Loader
 * Loads CIFAR-10 binary dataset from data/cifar/cifar-10-batches-bin
 *
 * Pre-requisite: Run `node src/utils/downloadCIFAR.js` to download data first.
 */

const fs = require('fs');
const path = require('path');

class CIFARFileLoader {
  constructor(dataDir = path.join(__dirname, '..', 'data', 'cifar', 'cifar-10-batches-bin')) {
    this.dataDir = dataDir;
    this.trainBatchFiles = [
      'data_batch_1.bin',
      'data_batch_2.bin',
      'data_batch_3.bin',
      'data_batch_4.bin',
      'data_batch_5.bin',
    ].map((name) => path.join(dataDir, name));
    this.testBatchFile = path.join(dataDir, 'test_batch.bin');
    this.recordBytes = 3073; // 1 label byte + 3072 image bytes (32*32*3)
    this.imageBytes = 3072;
  }

  checkDataAvailable() {
    const required = [...this.trainBatchFiles, this.testBatchFile];
    for (const file of required) {
      if (!fs.existsSync(file)) {
        throw new Error(
          `CIFAR-10 data file missing: ${path.basename(file)}\n` +
          'Please run: node src/utils/downloadCIFAR.js'
        );
      }
    }
  }

  parseBatchFile(filePath, maxRecords = Infinity) {
    const buffer = fs.readFileSync(filePath);
    const totalRecords = Math.floor(buffer.length / this.recordBytes);
    const recordsToRead = Math.min(totalRecords, maxRecords);

    const images = new Array(recordsToRead);
    const labels = new Array(recordsToRead);

    for (let i = 0; i < recordsToRead; i++) {
      const recordOffset = i * this.recordBytes;
      const label = buffer[recordOffset];

      // CIFAR binary format is channel-first [R(1024), G(1024), B(1024)].
      // Convert to channel-last [32, 32, 3] flattened as RGBRGB... for tf.tensor4d.
      const image = new Float32Array(this.imageBytes);
      const redOffset = recordOffset + 1;
      const greenOffset = redOffset + 1024;
      const blueOffset = greenOffset + 1024;

      for (let p = 0; p < 1024; p++) {
        const out = p * 3;
        image[out] = buffer[redOffset + p] / 255;
        image[out + 1] = buffer[greenOffset + p] / 255;
        image[out + 2] = buffer[blueOffset + p] / 255;
      }

      const oneHot = new Array(10).fill(0);
      oneHot[label] = 1;

      images[i] = Array.from(image);
      labels[i] = oneHot;
    }

    return { images, labels };
  }

  async loadTrainingData(maxSamples = 50000) {
    this.checkDataAvailable();

    const images = [];
    const labels = [];

    let remaining = maxSamples;
    for (const batchPath of this.trainBatchFiles) {
      if (remaining <= 0) {
        break;
      }

      const parsed = this.parseBatchFile(batchPath, remaining);
      images.push(...parsed.images);
      labels.push(...parsed.labels);
      remaining -= parsed.images.length;
    }

    return { images, labels };
  }

  async loadTestData(maxSamples = 10000) {
    this.checkDataAvailable();
    return this.parseBatchFile(this.testBatchFile, maxSamples);
  }
}

module.exports = CIFARFileLoader;
