#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { LiahonaStack } from '../lib/stack.js';

const app = new App();
new LiahonaStack(app, 'LiahonaManager', {
  description: 'Liahona Manager: camp roster, journeys and sign-ups',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-west-2' }
});
