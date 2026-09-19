'use strict';

require('dotenv').config();

const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const { skill } = require('./skill');

const verifySignature = process.env.SKIP_ALEXA_VERIFICATION !== 'true';
const adapter = new ExpressAdapter(skill, verifySignature, verifySignature);

const app = express();

app.post('/alexa', adapter.getRequestHandlers());

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Plex Alexa skill server listening on port ${port}`);
  if (!process.env.PLEX_BASE_URL || !process.env.PLEX_TOKEN) {
    console.warn('PLEX_BASE_URL and/or PLEX_TOKEN are not set — requests will fail until configured.');
  }
});
