#!/usr/bin/env node
import 'source-map-support/register';

import { AmiTestHarnessRepoStack } from '../lib/test-harness-repo';
import { getConfig } from '../lib/common';

import cdk = require('@aws-cdk/cdk');

const stackName = process.env.STACK_NAME || 'AmiBuildPipelineTestHarness';
const config = getConfig();

const app = new cdk.App();

new AmiTestHarnessRepoStack(app, stackName, {
    repoName: config.testHarnessRepo
});
