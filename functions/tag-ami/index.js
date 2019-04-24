'use strict';

const aws = require('aws-sdk');
const zip = require('jszip');

const TagName = 'TestStatus';
const TagValue = 'PASSED';
const ArtifactName = 'TestResult';
const ManifestFileName = 'manifest.json';
const AwsRegion = process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'] || '';


function getAmiIDsByRegion(str) {
    let images = {};
    const manifest = JSON.parse(str);
    manifest.builds[0].artifact_id.split(',').forEach(regionIdPair => {
        let region = regionIdPair.split(':')[0];
        let amiId = regionIdPair.split(':')[1];
        images[region] = amiId;
    });
    return images;
}

async function getArtifactByName(job, name) {
    const credentials = job.data.artifactCredentials;
    const s3 = new aws.S3({
        accessKeyId: credentials.accessKeyId,
        sessionToken: credentials.sessionToken,
        secretAccessKey: credentials.secretAccessKey
    });
    for (const artifact of job.data.inputArtifacts) {
        if (artifact.name === name) {
            const location = artifact.location.s3Location;
            console.log(`Fetching artifact ${name} from S3...`)
            const data = await s3.getObject({
                Bucket: location.bucketName,
                Key: location.objectKey
            }).promise();
            return data.Body;
        }
    }
    throw new Error(`artifact ${name} not found`);
}

exports.tagImage = async function(event, context) {
    const ec2 = new aws.EC2();
    const codepipeline = new aws.CodePipeline();
    const job = event['CodePipeline.job'];
    const jobId = job.id;

    try {
        const data = await getArtifactByName(job, ArtifactName);
        const zipFile = await zip.loadAsync(data);
        const manifestFile = await zipFile.file(ManifestFileName).async('string');
        const amis = await getAmiIDsByRegion(manifestFile);
        const amiId = amis[AwsRegion];

        const params = {
            Resources: [amiId],
            Tags: [{
                Key: TagName,
                Value: TagValue
            }]
        };
        console.log(`Executing ec2:createTags with params: ${JSON.stringify(params)}`);
        await ec2.createTags(params).promise();
        await codepipeline.putJobSuccessResult({
            jobId: jobId,
        }).promise();
    } catch (err) {
        console.log(err.message);
        await codepipeline.putJobFailureResult({
            failureDetails: err.message,
            jobId: jobId
        }).promise();
    }
}
