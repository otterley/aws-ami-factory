import path = require('path');
import fs = require('fs');
import yaml = require('js-yaml');
import Ajv = require('ajv');

const SchemaPath = path.join(__dirname, '..', 'pipeline-config-schema.json');
const ConfigPath = path.join(__dirname, '..', 'pipeline-config.yaml');

export const DestinationRoleName = 'AmiSnapshotCopyRole';

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
    testHarnessRepo: string
    testHarnessVersion?: string
    builderAccountId: string
    shareWith?: ShareWith[]
}

export function getConfig(): PipelineConfig {
    const schema = JSON.parse(fs.readFileSync(SchemaPath).toString());
    const config: PipelineConfig = yaml.safeLoad(fs.readFileSync(ConfigPath).toString());

    const ajv = new Ajv();
    const valid = ajv.validate(schema, config);
    if (!valid) {
        throw new Error(ajv.errorsText());
    }
    return config;
}
