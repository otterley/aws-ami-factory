/*
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import path = require('path');
import fs = require('fs');
import yaml = require('js-yaml');
import Ajv = require('ajv');
import { spawnSync } from 'child_process';

const SchemaPath = path.join(__dirname, '..', 'pipeline-config-schema.json');
const ConfigPath = path.join(__dirname, '..', 'pipeline-config.yaml');

// TODO: change this to be a URL
const ApplicationName = 'AMIPipelineBuilder';

export const DestinationRoleName = 'AMICopyRole';
export const AppTagName = 'BuiltWith';

interface ShareWith {
    accountId: string
    profile?: string
    regions: string[]
}

export interface PipelineConfig {
    amiName: string
    instanceSubnetId: string
    sourceS3Bucket: string
    sourceS3Key: string
    builderAccountId: string
    builderRegion: string
    shareWith?: ShareWith[]
    pipelineResourceTags: {[index: string]: string}
}

export function getConfig(): PipelineConfig {
    const schema = JSON.parse(fs.readFileSync(SchemaPath).toString());
    const config: PipelineConfig = yaml.safeLoad(fs.readFileSync(ConfigPath).toString());

    const ajv = new Ajv();
    const valid = ajv.validate(schema, config);
    if (!valid) {
        const errorText = ajv.errorsText().replace('data should have required property', `file ${ConfigPath} must have property`);
        throw new Error(errorText);
    }
    return config;
}

export function gitTag(): string {
    const response = spawnSync('git', ['describe', '--tags', '--always']);
    return response.stdout.toString().trim();
}

export function appTagValue(): string {
    return `${ApplicationName}@${gitTag()}`;
}
