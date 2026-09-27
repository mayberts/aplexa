'use strict';

require('dotenv').config();

const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const { skill } = require('./skill');

const verifySignature = process.env.SKIP_ALEXA_VERIFICATION !== 'true';
const adapter = new ExpressAdapter(skill, verifySignature, verifySignature);

const app = express();

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms) from ${req.ip}`);
  });
  next();
});

app.post('/alexa', adapter.getRequestHandlers());

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return next(err);
  res.status(500).send('error');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Plex Alexa skill server listening on port ${port}`);
  if (!process.env.PLEX_BASE_URL || !process.env.PLEX_TOKEN) {
    console.warn('PLEX_BASE_URL and/or PLEX_TOKEN are not set — requests will fail until configured.');
  }
});
