/*
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import sourceMapSupport = require('source-map-support');
sourceMapSupport.install();

import { AmiBuildPipelineStack } from '../lib/build-pipeline';
import { AmiCopyRoleStack } from '../lib/ami-copy-role';
import { getConfig } from '../lib/common';
import { App } from '@aws-cdk/core';

const app = new App();
const config = getConfig();

new AmiBuildPipelineStack(app, `AmiBuildPipeline-${config.amiName}`, {
    env: {
        account: config.builderAccountId,
        region: config.builderRegion
    },
    amiName: config.amiName,
    instanceSubnetId: config.instanceSubnetId,
    resourceTags: config.pipelineResourceTags,
    sourceS3Bucket: config.sourceS3Bucket, // "ami-source-4c709489",
    sourceS3Key: config.sourceS3Key,
    shareWith: config.shareWith || []
});

for (const target of config.shareWith || []) {
    new AmiCopyRoleStack(app, `AmiCopyRole-${target.accountId}`, {
        env: {
            account: target.accountId,
        },
        builderAccountId: config.builderAccountId
    });
}
