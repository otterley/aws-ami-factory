'use strict';

const aws = require('aws-sdk');
const JSZip = require('jszip');

// Source region
const region = process.env.AWS_REGION;
const artifactName = process.env.INPUT_ARTIFACT_NAME;
const stateMachineArn = process.env.STATE_MACHINE_ARN;
const manifestFileName = 'manifest.json';

function getAmiIDsByRegion(manifest) {
    let images = {};
    manifest.builds[0].artifact_id.split(',').forEach(regionIdPair => {
        let region = regionIdPair.split(':')[0];
        let amiId = regionIdPair.split(':')[1];
        images[region] = amiId;
    });
    return images;
}

function kmsKeyPolicy(accountId, roleArn) {
    return {
        Version: '2012-10-17',
        Statement: [{
                Sid: 'Enable IAM User Permissions',
                Effect: 'Allow',
                Principal: {
                    AWS: `arn:aws:iam::${accountId}:root`
                },
                Action: 'kms:*',
                Resource: '*'
            },
            {
                Sid: 'Allow importer role to use key',
                Effect: 'Allow',
                Principal: {
                    AWS: roleArn
                },
                Action: [
                    'kms:Encrypt',
                    'kms:Decrypt',
                    'kms:ReEncrypt*',
                    'kms:GenerateDataKey*',
                    'kms:DescribeKey'
                ],
                Resource: '*'
            },
            {
                Sid: 'Allow importer role to grant access to EBS for decryption',
                Effect: 'Allow',
                Principal: {
                    AWS: roleArn
                },
                Action: [
                    'kms:CreateGrant',
                    'kms:ListGrants',
                    'kms:RevokeGrant'
                ],
                Condition: {
                    Bool: {
                        'kms:GrantIsForAWSResource': true
                    }
                }
            }
        ]
    }
}

async function createKmsKey(client, description, accountId, roleArn) {
    const response = await client.createKey({
        Description: description,
        BypassPolicyLockoutSafetyCheck: true,
        Policy: JSON.stringify(kmsKeyPolicy(accountId, roleArn))
    }).promise();
    return response.KeyMetadata.Arn;
}

exports.kickoff = async function(event, context) {
    // Extract job details
    const job = event['CodePipeline.job'];
    console.log(`Job ID: ${job.id}`);

    try {
        const parameters = JSON.parse(job.data.actionConfiguration.configuration.UserParameters);

        // Obtain artifact from S3
        const s3 = new aws.S3({ ...job.data.artifactCredentials });
        const artifact = job.data.inputArtifacts.find(artifact => artifact.name === artifactName);
        const s3Location = artifact.location.s3Location;

        console.log(`Retrieving artifact from s3://${s3Location.bucketName}/${s3Location.objectKey}`);
        const artifactObject = await s3.getObject({
            Bucket: s3Location.bucketName,
            Key: s3Location.objectKey
        }).promise();

        // Obtain manifest file from artifact ZIP file
        console.log(`Unpacking ${manifestFileName} from artifact ZIP file`);
        const zipFile = await new JSZip().loadAsync(artifactObject.Body);
        const manifest = await zipFile.file(manifestFileName).async('string');

        // Obtain AMI ID from manifest
        const amiMap = getAmiIDsByRegion(JSON.parse(manifest));
        const amiId = amiMap[region];

        // Enable sharing on all the snapshots associated with the AMI
        const ec2 = new aws.EC2();
        const imageAttrs = await ec2.describeImages({
            ImageIds: [amiId]
        }).promise();
        const image = imageAttrs.Images[0];
        for (const blockDevice of image.BlockDeviceMappings) {
            const snapshotId = blockDevice.Ebs.SnapshotId;
            console.log(`Sharing snapshot ID ${snapshotId} with account ${parameters.destinationAccountId} ...`);
            await ec2.modifySnapshotAttribute({
                SnapshotId: snapshotId,
                Attribute: 'createVolumePermission',
                OperationType: 'add',
                UserIds: [parameters.destinationAccountId.toString()]
            }).promise();
        }

        // Invoke step function
        const response = await new aws.StepFunctions().startExecution({
            stateMachineArn: stateMachineArn,
            input: JSON.stringify({
                jobId: job.id,
                sourceImageId: amiId,
                ...parameters
            })
        }).promise();

        console.log(`Started copy-AMI state machine: ${response.executionArn}`);
    } catch (err) {
        const errmsg = `ERROR: ${err.name}: ${err.message}`;
        console.log(errmsg);
        await new aws.CodePipeline().putJobFailureResult({
            jobId: job.id,
            failureDetails: {
                type: 'JobFailed',
                message: errmsg
            }
        }).promise();
    }
}

// Notify codepipeline of success
exports.notifySuccess = async function(event, context) {
    console.log(JSON.stringify(event));
    console.log(`Sending Success Result to job ${event.jobId}`);
    await new aws.CodePipeline().putJobSuccessResult({
        jobId: event.jobId,
    }).promise();
};

// Notify codepipeline of failure
exports.notifyFailure = async function(event, context) {
    console.log(JSON.stringify(event));
    console.log(`Sending Failure Result to job ${event.jobId}`);
    await new aws.CodePipeline().putJobFailureResult({
        jobId: event.jobId,
        failureDetails: {
            type: 'JobFailed',
            message: `Error occurred during copy of snapshot to ${event.destinationAccountId}/${event.destinationRegion}, snapshot ID ${event.destinationSnapshotId}`
        }
    }).promise();
};


// Copy image to another account and region
exports.copySnapshot = async function(event, context) {
    console.log(JSON.stringify(event));

    const roleArn = `arn:aws:iam::${event.destinationAccountId}:role/${event.destinationRoleName}`

    // Determine the local (source) account ID
    const sts = new aws.STS();
    const callerIdentity = await sts.getCallerIdentity().promise();

    // Collect source AMI attributes so we can use them later for registering
    // the AMI in the remote account
    const imageAttrs = await new aws.EC2().describeImages({
        ImageIds: [event.sourceImageId]
    }).promise();
    event.sourceImageAttrs = imageAttrs.Images[0];

    const assumeRoleResponse = await sts.assumeRole({
        RoleArn: roleArn,
        RoleSessionName: `CopyAMI-${event.amiName}`
    }).promise();

    const foreignAccountParams = {
        accessKeyId: assumeRoleResponse.Credentials.AccessKeyId,
        secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey,
        sessionToken: assumeRoleResponse.Credentials.SessionToken,
        region: event.destinationRegion
    };

    const ec2 = new aws.EC2(foreignAccountParams);
    const kms = new aws.KMS(foreignAccountParams);

    try {
        await kms.describeKey({
            KeyId: event.kmsKeyAlias
        }).promise();
        // Keep key policy up to date - sometimes the foreign role ARNs get
        // changed to IDs when we replace them for maintenance, which breaks
        // things
        console.log(`Updating policy for key ${event.kmsKeyAlias}`);
        await kms.putKeyPolicy({
            BypassPolicyLockoutSafetyCheck: true,
            KeyId: event.kmsKeyAlias,
            PolicyName: 'EBSVolume',
            Policy: JSON.stringify(kmsKeyPolicy(event.destinationAccountId, roleArn))
        }).promise();
    } catch (e) {
        if (e.code === 'NotFoundException') {
            console.log(`KMS key alias ${event.kmsKeyAlias} not found.  Creating new KMS CMK...`);
            const kmsKeyId = await createKmsKey(
                kms,
                `AMI encryption key - ${event.amiName}`,
                event.destinationAccountId,
                roleArn
            );

            console.log(`New CMK created with ID ${kmsKeyId}.  Creating alias ${event.kmsKeyAlias}...`);
            await kms.createAlias({
                AliasName: event.kmsKeyAlias,
                TargetKeyId: kmsKeyId
            }).promise();
        } else {
            // Some other exception occurred
            throw (e);
        }
    }

    const sourceSnapshotId = event.sourceImageAttrs.BlockDeviceMappings[0].Ebs.SnapshotId;

    const copySnapshotParams = {
        Description: `${event.amiName} - Copied from ${sourceSnapshotId} in ${region} from account ${callerIdentity.Account}`,
        SourceRegion: region,
        DestinationRegion: event.destinationRegion,
        Encrypted: true,
        SourceSnapshotId: sourceSnapshotId,
        KmsKeyId: event.kmsKeyAlias
    };
    console.log(`Initiating CopySnapshot process with params: ${JSON.stringify(copySnapshotParams)}`)
    const copySnapshotResponse = await ec2.copySnapshot(copySnapshotParams).promise();

    // Return event structure after attaching snapshotID
    event.destinationSnapshotId = copySnapshotResponse.SnapshotId;
    return event;
};



exports.checkSnapshotProgress = async function(event, context) {
    const roleArn = `arn:aws:iam::${event.destinationAccountId}:role/${event.destinationRoleName}`

    const sts = new aws.STS();
    const assumeRoleResponse = await sts.assumeRole({
        RoleArn: roleArn,
        RoleSessionName: `CheckSnapshotProgress-${event.amiName}`
    }).promise();

    const foreignAccountParams = {
        accessKeyId: assumeRoleResponse.Credentials.AccessKeyId,
        secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey,
        sessionToken: assumeRoleResponse.Credentials.SessionToken,
        region: event.destinationRegion
    };
    const ec2 = new aws.EC2(foreignAccountParams);

    const response = await ec2.describeSnapshots({
        SnapshotIds: [event.destinationSnapshotId]
    }).promise();

    const snapshot = response.Snapshots[0];

    event.snapshotProgress = snapshot.Progress;
    event.snapshotState = snapshot.State;
    event.snapshotStateMessage = snapshot.StateMessage;

    return event;
};



exports.registerImage = async function(event, context) {
    const roleArn = `arn:aws:iam::${event.destinationAccountId}:role/${event.destinationRoleName}`

    const sts = new aws.STS();
    const assumeRoleResponse = await sts.assumeRole({
        RoleArn: roleArn,
        RoleSessionName: `CheckSnapshotProgress-${event.amiName}`
    }).promise();

    const foreignAccountParams = {
        accessKeyId: assumeRoleResponse.Credentials.AccessKeyId,
        secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey,
        sessionToken: assumeRoleResponse.Credentials.SessionToken,
        region: event.destinationRegion
    };
    const ec2 = new aws.EC2(foreignAccountParams);

    const params = {
        Name: event.sourceImageAttrs.Name,
        Architecture: event.sourceImageAttrs.Architecture,
        BillingProducts: event.sourceImageAttrs.BillingProducts,
        BlockDeviceMappings: [{
            DeviceName: event.sourceImageAttrs.BlockDeviceMappings[0].DeviceName,
            Ebs: {
                SnapshotId: event.destinationSnapshotId,
                DeleteOnTermination: event.sourceImageAttrs.BlockDeviceMappings[0].Ebs.DeleteOnTermination,
                VolumeType: event.sourceImageAttrs.BlockDeviceMappings[0].Ebs.VolumeType,
                VolumeSize: event.sourceImageAttrs.BlockDeviceMappings[0].Ebs.VolumeSize
            }
        }],
        VirtualizationType: event.sourceImageAttrs.VirtualizationType,
        Description: event.sourceImageAttrs.Description,
        EnaSupport: event.sourceImageAttrs.EnaSupport,
        SriovNetSupport: event.sourceImageAttrs.SriovNetSupport,
        KernelId: event.sourceImageAttrs.KernelId,
        RamdiskId: event.sourceImageAttrs.RamdiskId,
        RootDeviceName: event.sourceImageAttrs.RootDeviceName
    };
    console.log('Calling RegisterImage with parameters: ' + JSON.stringify(params));

    const response = await ec2.registerImage(params).promise();

    event.destinationImageId = response.ImageId;

    await ec2.createTags({
        Resources: [
            event.destinationImageId,
            event.destinationSnapshotId
        ],
        Tags: event.sourceImageAttrs.Tags
    }).promise();

    return event;
};
