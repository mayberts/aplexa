'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal ask-sdk PersistenceAdapter backed by one JSON file per user on
 * local disk. Sufficient for a single self-hosted instance serving a
 * handful of Alexa devices on one account; not safe for multi-process
 * deployments (no file locking).
 */
class FilePersistenceAdapter {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  _fileFor(userId) {
    return path.join(this.dataDir, `${encodeURIComponent(userId)}.json`);
  }

  async getAttributes(requestEnvelope) {
    const userId = requestEnvelope.context.System.user.userId;
    const file = this._fileFor(userId);
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`Failed to read persistence file for ${userId}`, err);
      return {};
    }
  }

  async saveAttributes(requestEnvelope, attributes) {
    const userId = requestEnvelope.context.System.user.userId;
    fs.writeFileSync(this._fileFor(userId), JSON.stringify(attributes), 'utf8');
  }

  async deleteAttributes(requestEnvelope) {
    const userId = requestEnvelope.context.System.user.userId;
    const file = this._fileFor(userId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

module.exports = { FilePersistenceAdapter };
