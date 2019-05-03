#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/cdk');
import { AmiBuildPipeline } from '../lib/pipeline';

const app = new cdk.App();
new AmiBuildPipeline(app, 'Stack', {
    name: 'test',
    subnetId: 'subnet-1234124',
    sourceBucketName: 'test-source-bucket',
    testHarnessRepoName: 'test',
    sourceKey: 'foo.zip',
    artifactBucketName: 'test-artifact-bucket',
    shareWith: {
        '123456789012': ['us-west-1', 'us-east-2'],
        '345678901234': ['us-west-1', 'us-east-2'],
    }
});
