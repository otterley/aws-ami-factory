#!/usr/bin/env node

/*
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const aws = require('aws-sdk');
const jsonfile = require('jsonfile');
const tmp = require('tmp');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const uuid = require('uuid/v4');
const { spawn } = require('child_process');
const waitPort = require('wait-port');
const { minutes } = require('date-unit-ms');

const SourceDir = process.env['CODEBUILD_SRC_DIR'] || '';
const TestDir = path.join(SourceDir, 'test', 'inspec');
const AwsRegion = process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'] || '';
const SubnetId = process.env['SUBNET_ID'];
const InstanceType = process.env['EC2_INSTANCE_TYPE'] || 't2.small';
const ManifestFile = require('path').join(SourceDir, 'manifest.json');
const CodeBuildSourceVersionFile = require('path').join(SourceDir, 'CODEBUILD_SOURCE_VERSION');
const CodeBuildResolvedSourceVersionFile = require('path').join(SourceDir, 'CODEBUILD_RESOLVED_SOURCE_VERSION');
const CodeBuildIdFile = require('path').join(SourceDir, 'CODEBUILD_BUILD_ID');

const LoginName = process.env['LOGIN_NAME'] || 'ec2-user';

const TestStatusTagName = 'TestStatus';
const TestStatusTagValuePassed = 'PASSED';
const TestStatusTagValueFailed = 'FAILED';

const ExitOK = 0;

// eslint-disable-next-line no-magic-numbers
const SSHWaitTimeout = 5 * minutes;


async function getAmiIDsByRegion(path) {
    let images = {};
    const manifest = await jsonfile.readFile(path);
    manifest.builds[0].artifact_id.split(',').forEach(regionIdPair => {
        let region = regionIdPair.split(':')[0];
        let amiId = regionIdPair.split(':')[1];
        images[region] = amiId;
    });
    return images;
}

/*
 * Wrap `cb` in a harness that sets up an appropriate VPC security group and EC2
 * Key Pair. `cb` must be an async function. It will be called with the
 * temporary key name, a path to the EC2 private key, and the temporary security
 * group ID. Tidy up after ourselves by getting rid of the temporary AWS
 * resources after `cb` has run, or if an error occurs.
 */
function withTestSecurityGroupAndKey(subnetId, cb) {
    const ec2 = new aws.EC2();
    return new Promise((resolve, reject) => {
        tmp.file(async (err, keyPath, keyfd) => {
            if (err) {
                reject(err);
            }

            let keyPair, response, securityGroup;

            try {
                // Get VPC ID from subnet
                const subnet = await ec2.describeSubnets({
                    SubnetIds: [subnetId]
                }).promise();

                // Set up security group in subnet
                securityGroup = await ec2.createSecurityGroup({
                    Description: 'Allows inbound SSH',
                    GroupName: `ec2-test-${uuid()}`,
                    VpcId: subnet.Subnets[0].VpcId
                }).promise();
                await ec2.authorizeSecurityGroupIngress({
                    GroupId: securityGroup.GroupId,
                    IpPermissions: [{
                        FromPort: 22,
                        ToPort: 22,
                        IpProtocol: 'tcp',
                        IpRanges: [{
                            CidrIp: '0.0.0.0/0'
                        }]
                    }]
                }).promise();
                console.log(`Created temporary security group ${securityGroup.GroupId}`);

                keyPair = await ec2.createKeyPair({
                    KeyName: `ec2-test-${uuid()}`
                }).promise();
                console.log(`Created temporary key pair ${keyPair.KeyName}`);

                await promisify(fs.write)(keyfd, keyPair.KeyMaterial);
                response = await cb(keyPair.KeyName, keyPath, securityGroup.GroupId);
            } catch (err) {
                reject(err);
            } finally {
                // Cleanup
                try {
                    if (securityGroup) {
                        console.log(`Deleting temporary security group ${securityGroup.GroupId} ...`);
                        await ec2.deleteSecurityGroup({
                            GroupId: securityGroup.GroupId
                        }).promise();
                    }
                    if (keyPair) {
                        console.log(`Deleting temporary key pair ${keyPair.KeyName} ...`);
                        await ec2.deleteKeyPair({
                            KeyName: keyPair.KeyName
                        }).promise();
                    }
                } catch (err) {
                    console.log(err);
                }

                resolve(response);
            }
        });
    });
}

/*
 * Wrap `cb` in a harness that launches an EC2 Instance with the specified
 * parameters to `ec2.runInstances`.
 *
 * `cb` must be an async function.  It will be called with an instance of
 * AWS.EC2.Instance. Tidy up after ourselves by getting rid of the temporary
 * instance after `cb` has run, or if an error occurs.
 */
async function withTestInstance(params, cb) {
    const ec2 = new aws.EC2();

    let instance;

    try {
        const response = await ec2.runInstances({
            ...params,
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [{
                ResourceType: 'instance',
                Tags: [{
                    Key: 'Name',
                    Value: 'TestInstance'
                }]
            }]
        }).promise();
        instance = response.Instances[0];
        await ec2.waitFor('instanceRunning', {
            InstanceIds: [instance.InstanceId]
        }).promise();
        await cb(instance);
    } finally {
        try {
            if (instance) {
                console.log(`Terminating instance ${instance.InstanceId}...`);
                await ec2.terminateInstances({
                    InstanceIds: [instance.InstanceId]
                }).promise();
                await ec2.waitFor('instanceTerminated', {
                    InstanceIds: [instance.InstanceId]
                }).promise();
            }
        } catch (err) {
            console.log(err);
        }
    }
}

/*
 * Run InSpec against the test instance.
 */
async function runTest(instance, keyPath) {
    const ec2 = new aws.EC2();

    const instanceInfo = await ec2.describeInstances({
        InstanceIds: [instance.InstanceId]
    }).promise();
    const publicIpAddr = instanceInfo.Reservations[0].Instances[0].PublicIpAddress;

    console.log(`Waiting for SSH port on ${publicIpAddr} to become available...`);

    await waitPort({
        host: publicIpAddr,
        port: 22,
        timeout: SSHWaitTimeout
    });

    return new Promise((resolve, reject) => {
        console.log('Starting InSpec...');
        const process = spawn('inspec', ['exec',
            '-b', 'ssh',
            '-i', keyPath,
            '--host', publicIpAddr,
            '--user', LoginName,
            '--sudo',
            '--no-color',
            // Don't exit nonzero if tests are skipped
            '--no-distinct-exit',
            TestDir
        ], {
            // Don't squelch stdout/stderr
            stdio: 'inherit'
        });
        process.on('error', err => reject(err));
        process.on('close', exitCode => resolve(exitCode));
    });
}

/*
 * Tag a machine image (AMI) and its corresponding snapshot(s) with the specified tags.
 */
async function tagImage(amiId, tags) {
    const ec2 = new aws.EC2();
    let tagArray = [];

    for (let tagName in tags) {
        if (Reflect.has(tags, tagName)) {
            tagArray.push({
                Key: tagName,
                Value: tags[tagName]
            });
        }
    }

    const ami = await ec2.describeImages({
        ImageIds: [amiId]
    }).promise();
    const snapshots = ami.Images[0].BlockDeviceMappings.map(mapping => mapping.Ebs.SnapshotId);
    const resourcesToTag = [amiId].concat(snapshots);

    const params = {
        Resources: resourcesToTag,
        Tags: tagArray
    };
    await ec2.createTags(params).promise();
}

async function writeFile(path, content) {
    let fd;
    try {
        fd = await promisify(fs.open)(path, 'w');
        await promisify(fs.write)(fd, content);
    } finally {
        await promisify(fs.close)(fd);
    }
}

async function main() {
    try {
        let amiId, statusTagValue;
        const amis = await getAmiIDsByRegion(ManifestFile);
        await withTestSecurityGroupAndKey(SubnetId, async (keyName, keyPath, securityGroupId) => {
            amiId = amis[AwsRegion];
            const params = {
                ImageId: amiId,
                InstanceType: InstanceType,
                KeyName: keyName,
                NetworkInterfaces: [{
                    AssociatePublicIpAddress: true,
                    DeleteOnTermination: true,
                    DeviceIndex: 0,
                    Groups: [securityGroupId],
                    SubnetId: SubnetId
                }]
            };
            console.log(`Launching new instance with AMI ID ${params.ImageId} into subnet ${params.NetworkInterfaces[0].SubnetId} ...`);
            await withTestInstance(params, async instance => {
                console.log(`Instance ID: ${instance.InstanceId}`);
                process.exitCode = await runTest(instance, keyPath);
            });

            if (process.exitCode === ExitOK) {
                statusTagValue = TestStatusTagValuePassed;
            } else {
                statusTagValue = TestStatusTagValueFailed;
            }
            await tagImage(amiId, {
                [TestStatusTagName]: statusTagValue
            });
            if (process.env.CODEBUILD_SOURCE_VERSION) {
                await writeFile(CodeBuildSourceVersionFile, process.env.CODEBUILD_SOURCE_VERSION);
            }
            if (process.env.CODEBUILD_BUILD_ID) {
                await writeFile(CodeBuildIdFile, process.env.CODEBUILD_BUILD_ID);
            }
            if (process.env.CODEBUILD_RESOLVED_SOURCE_VERSION) {
                await writeFile(CodeBuildResolvedSourceVersionFile, process.env.CODEBUILD_RESOLVED_SOURCE_VERSION);
            }
        });
    } catch (err) {
        console.log(err.message);
        process.exitCode = 2;
    }
}

main();
