#!/usr/bin/env node
import 'source-map-support/register';
import { AmiSnapshotCopyRoleStack } from '../lib/ami-snapshot-copy-role';
import { getConfig } from '../lib/common';

import cdk = require('@aws-cdk/cdk');

const config = getConfig();

const stackName = process.env.STACK_NAME || 'AmiSnapshotCopyRole';

const app = new cdk.App();

new AmiSnapshotCopyRoleStack(app, stackName, {
    builderAccountId: config.builderAccountId
});
