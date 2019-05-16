#!/usr/bin/env node
import 'source-map-support/register';
import { AmiBuildPipelineStack } from '../lib/build-pipeline';
import { getConfig } from '../lib/common';

import cdk = require('@aws-cdk/cdk');

const app = new cdk.App();

const config = getConfig();

new AmiBuildPipelineStack(app, config.amiName + 'BuildPipeline', {
    amiName: config.amiName,
    instanceSubnetId: config.instanceSubnetId,
    sourceS3Bucket: config.sourceS3Bucket, // "ami-source-4c709489",
    sourceS3Key: config.sourceS3Key,
    testHarnessImageRepo: config.testHarnessRepo,
    shareWith: config.shareWith || []
});
