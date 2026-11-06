const serverless = require('serverless-http');
const { app, startupReady } = require('../../FEDF-Backend-main/server');

const handler = serverless(app);

exports.handler = async (event, context) => {
  await startupReady;
  return handler(event, context);
};
